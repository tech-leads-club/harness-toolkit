import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderWiring, RuntimePaths, WiringEntry } from "../../contracts/index.ts";
import { codexConfigDir } from "../../platform/paths.ts";

const ENTRIES = [
  ["SessionStart", "session-start", 10],
  ["SessionEnd", "session-end", 3],
  ["UserPromptSubmit", "prompt-submit", 5],
  ["PreToolUse", "tool-before", 120],
  ["PostToolUse", "tool-after", 10],
  ["SubagentStart", "subagent-start", 5],
  ["SubagentStop", "subagent-stop", 5],
  ["Stop", "stop", 120],
  ["PreCompact", "compact-before", 5],
] as const;

export function codexWiringTargets(): string[] {
  return [join(codexConfigDir(), "hooks.json"), join(codexConfigDir(), "config.toml")];
}
export function codexWiring(runtime: RuntimePaths): ProviderWiring {
  return {
    target: join(codexConfigDir(), "hooks.json"),
    strategy: "merge",
    commandFormat: "shell",
    entries: ENTRIES.map(([hookEvent, handler, timeoutSeconds]) => ({
      hookEvent,
      handler,
      timeoutSeconds,
      command: "node",
      args: [runtime.launcherPath, handler, "--provider", "codex"],
    })),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function ours(value: unknown): boolean {
  return (
    object(value) &&
    typeof value.command === "string" &&
    value.command.includes("tlc-exec.mjs") &&
    /(?:^|\s)(?:'--provider'|"--provider"|--provider)\s+(?:'codex'|"codex"|codex)(?=\s|$)/.test(value.command)
  );
}
function quote(token: string): string {
  return `'${token.replaceAll("'", "'\"'\"'")}'`;
}
function windowsQuote(token: string): string {
  return `'${token.replaceAll("'", "''")}'`;
}

export function mergeCodexHooks(
  text: string | null,
  entries: readonly WiringEntry[] = [],
): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  try {
    const doc: unknown = text?.trim() ? JSON.parse(text) : {};
    if (!object(doc) || (doc.hooks !== undefined && !object(doc.hooks)))
      throw new Error("hooks.json must contain a hooks object");
    const hooks: Record<string, unknown[]> = {};
    for (const [name, groups] of Object.entries(doc.hooks ?? {})) {
      const kept = foreignGroups(name, groups);
      if (kept.length) hooks[name] = kept;
    }
    for (const entry of entries) {
      const tokens = [entry.command, ...entry.args];
      const handler = {
        type: "command",
        command: tokens.map(quote).join(" "),
        commandWindows: `& ${tokens.map(windowsQuote).join(" ")}`,
        timeout: entry.timeoutSeconds,
      };
      hooks[entry.hookEvent] = [...(hooks[entry.hookEvent] ?? []), { hooks: [handler] }];
    }
    const result = { ...doc };
    if (Object.keys(hooks).length) result.hooks = hooks;
    else delete result.hooks;
    return {
      ok: true,
      text: JSON.stringify(result, null, 2),
      changed: JSON.stringify(doc) !== JSON.stringify(result),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function applyCodexWiring(
  target: string,
  entries: readonly WiringEntry[] = [],
): ReturnType<typeof mergeCodexHooks> {
  const result = mergeCodexHooks(existsSync(target) ? readFileSync(target, "utf8") : null, entries);
  if (result.ok && result.changed) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, result.text, "utf8");
  }
  return result;
}

function foreignGroups(name: string, groups: unknown): Record<string, unknown>[] {
  if (!Array.isArray(groups)) throw new Error(`Invalid hook groups for ${name}`);
  const kept = [];
  for (const group of groups) {
    if (!object(group) || !Array.isArray(group.hooks)) throw new Error(`Invalid hook group for ${name}`);
    const foreign = group.hooks.filter((handler) => !ours(handler));
    if (foreign.length || group.hooks.length === 0) kept.push({ ...group, hooks: foreign });
  }
  return kept;
}
