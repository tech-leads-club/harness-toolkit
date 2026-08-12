import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderWiring, RuntimePaths, WiringEntry } from "../../contracts/index.ts";
import { claudeConfigDir } from "../../platform/paths.ts";

type EntrySpec = {
  hookEvent: string;
  handler: string;
  timeoutSeconds: number;
  failClosed?: boolean;
  loopLimit?: number;
};

// why: PreToolUse and PostToolUse are each a single dispatcher entry — the fan-out lives in claude.inbound.ts,
// so Claude never registers a hook per tool the way Cursor registers one per dedicated event.
const ENTRY_SPECS: readonly EntrySpec[] = [
  { hookEvent: "SessionStart", handler: "session-start", timeoutSeconds: 10 },
  { hookEvent: "SessionEnd", handler: "session-end", timeoutSeconds: 10 },
  { hookEvent: "UserPromptSubmit", handler: "prompt-submit", timeoutSeconds: 5 },
  { hookEvent: "PreToolUse", handler: "tool-before", timeoutSeconds: 10, failClosed: true },
  { hookEvent: "PostToolUse", handler: "tool-after", timeoutSeconds: 10 },
  { hookEvent: "PostToolUseFailure", handler: "tool-failure", timeoutSeconds: 5 },
  { hookEvent: "SubagentStart", handler: "subagent-start", timeoutSeconds: 5, failClosed: true },
  { hookEvent: "SubagentStop", handler: "subagent-stop", timeoutSeconds: 5 },
  { hookEvent: "Stop", handler: "stop", timeoutSeconds: 120, loopLimit: 5 },
  { hookEvent: "PreCompact", handler: "compact-before", timeoutSeconds: 5 },
  { hookEvent: "MessageDisplay", handler: "response-after", timeoutSeconds: 5 },
];

export function claudeSettingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

// why: exec form only, on every platform — it bypasses shell tokenization, so there is no quoting variant to get wrong.
export function claudeWiring(runtime: RuntimePaths): ProviderWiring {
  const entries: WiringEntry[] = ENTRY_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command: "node",
    args: [runtime.launcherPath, spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
    ...(spec.failClosed !== undefined ? { failClosed: spec.failClosed } : {}),
    ...(spec.loopLimit !== undefined ? { loopLimit: spec.loopLimit } : {}),
  }));

  return {
    target: claudeSettingsPath(),
    strategy: "merge",
    entries,
  };
}

export type ClaudeSettingsHookEntry = { type: "command"; command: string; args: string[] };
export type ClaudeSettingsHookGroup = { hooks: ClaudeSettingsHookEntry[] };
export type ClaudeSettingsHooks = Record<string, ClaudeSettingsHookGroup[]>;

export type MergeSuccess = { ok: true; settingsText: string; changed: boolean };
export type MergeFailure = { ok: false; error: string; block: string };
export type MergeResult = MergeSuccess | MergeFailure;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHooksRecord(value: unknown): value is ClaudeSettingsHooks {
  return isPlainRecord(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) => bKeys.includes(key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function desiredHooksFor(entries: readonly WiringEntry[]): ClaudeSettingsHooks {
  const hooks: ClaudeSettingsHooks = {};
  for (const entry of entries) {
    const group: ClaudeSettingsHookGroup = {
      hooks: [{ type: "command", command: entry.command, args: entry.args }],
    };
    hooks[entry.hookEvent] = [...(hooks[entry.hookEvent] ?? []), group];
  }
  return hooks;
}

const LAUNCHER_MARKER = "tlc-exec.mjs";

export function isHarnessGroup(group: unknown): boolean {
  return JSON.stringify(group ?? null).includes(LAUNCHER_MARKER);
}

export function canonicalLauncherPath(path: string, resolve: (p: string) => string = realpathSync): string {
  try {
    return resolve(path);
  } catch {
    return path;
  }
}

// hazard: an installation reached through a symlink writes one path into settings.json and resolves another
// at runtime, so a structural comparison reports the wiring as broken every time. Comparing the launcher by
// the file it actually points at is what makes "wired" mean wired, and stops every update from rewriting
// a settings.json that was already correct.
export function canonicalizeGroups(groups: unknown, resolve?: (p: string) => string): unknown {
  return JSON.parse(
    JSON.stringify(groups ?? null, (_key, value) =>
      typeof value === "string" && value.includes(LAUNCHER_MARKER)
        ? canonicalLauncherPath(value, resolve)
        : value,
    ),
  );
}

export function mergeClaudeSettings(
  existingText: string | null,
  entries: readonly WiringEntry[],
): MergeResult {
  const desired = desiredHooksFor(entries);

  let settings: Record<string, unknown> = {};
  if (existingText !== null && existingText.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, block: JSON.stringify({ hooks: desired }, null, 2) };
    }
    if (!isPlainRecord(parsed)) {
      return {
        ok: false,
        error: "settings.json root is not a JSON object",
        block: JSON.stringify({ hooks: desired }, null, 2),
      };
    }
    settings = parsed;
  }

  const currentHooks = isHooksRecord(settings.hooks) ? settings.hooks : {};
  const mergedHooks: ClaudeSettingsHooks = { ...currentHooks };
  let changed = false;

  for (const [hookEvent, groups] of Object.entries(desired)) {
    const existingGroups = mergedHooks[hookEvent] ?? [];
    // hazard: appending only what is missing leaves a stale copy behind when the launcher path
    // changes, and every hook then fires twice. Ours are replaced wholesale; foreign ones stay.
    const foreign = existingGroups.filter((group) => !isHarnessGroup(group));
    const nextGroups = [...foreign, ...groups];
    if (!deepEqual(canonicalizeGroups(existingGroups), canonicalizeGroups(nextGroups))) {
      changed = true;
    }
    mergedHooks[hookEvent] = nextGroups;
  }

  const mergedSettings = { ...settings, hooks: mergedHooks };
  return { ok: true, settingsText: JSON.stringify(mergedSettings, null, 2), changed };
}

/**
 * The exact inverse of `mergeClaudeSettings`: every group `isHarnessGroup` matches leaves, everything else stays
 * where it was.
 *
 * hazard: this file is the operator's, not ours. It carries `permissions`, `sandbox`, `env` and `statusLine`
 * alongside our eleven hook groups, so deleting it — or rewriting it from a template — destroys work the
 * installer never wrote. Only groups are dropped, and only ours ([/decisions/ad-066.md](/decisions/ad-066.md)).
 */
export function unmergeClaudeSettings(existingText: string | null): MergeResult {
  if (existingText === null || existingText.trim() === "") {
    return { ok: true, settingsText: "", changed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, block: "" };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, error: "settings.json root is not a JSON object", block: "" };
  }

  const currentHooks = isHooksRecord(parsed.hooks) ? parsed.hooks : {};
  const remainingHooks: ClaudeSettingsHooks = {};
  let changed = false;

  for (const [hookEvent, groups] of Object.entries(currentHooks)) {
    const foreign = groups.filter((group) => !isHarnessGroup(group));
    if (foreign.length !== groups.length) {
      changed = true;
    }
    // invariant: an event whose only groups were ours loses its key. Leaving `"Stop": []` behind is residue that
    // reads as configuration, and it is exactly what makes a second run report work still to do.
    if (foreign.length > 0) {
      remainingHooks[hookEvent] = foreign;
    }
  }

  // why: rebuilt key by key rather than spread-and-override, so `hooks` keeps its position. An operator diffing
  // their own settings.json after this should see the hook groups leave and nothing else move.
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "hooks") {
      next[key] = value;
    } else if (Object.keys(remainingHooks).length > 0) {
      next.hooks = remainingHooks;
    }
  }
  return { ok: true, settingsText: JSON.stringify(next, null, 2), changed };
}

export function removeClaudeWiring(settingsPath: string): MergeResult {
  if (!existsSync(settingsPath)) {
    return { ok: true, settingsText: "", changed: false };
  }
  const result = unmergeClaudeSettings(readFileSync(settingsPath, "utf8"));
  if (result.ok && result.changed) {
    writeFileSync(settingsPath, result.settingsText, "utf8");
  }
  return result;
}

export function applyClaudeWiring(settingsPath: string, entries: readonly WiringEntry[]): MergeResult {
  const existingText = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  const result = mergeClaudeSettings(existingText, entries);
  if (result.ok && result.changed) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, result.settingsText, "utf8");
  }
  return result;
}
