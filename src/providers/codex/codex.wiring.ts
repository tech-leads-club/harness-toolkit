import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderWiring, RuntimePaths, WiringEntry } from "../../contracts/index.ts";
import { codexConfigDir } from "../../platform/paths.ts";
import type { ProviderWiringKind } from "../provider.port.ts";

export const CODEX_PROVIDER = "codex";

type EntrySpec = { hookEvent: string; handler: string; timeoutSeconds: number };

/**
 * The vendor's timeout rule, in seconds: 600 for most hooks, and 1 by default with a ceiling of 3 for `SessionEnd`
 * and `Interrupt` (`__test__/fixtures/PROVENANCE.md`).
 *
 * why it is expressed as data rather than as care taken when writing the table: a limit only a human remembers is
 * a limit that drifts. `CAPPED_EVENTS` is what the test reads, so adding an entry for either event with a larger
 * timeout fails rather than shipping a hook Codex kills mid-run.
 */
export const CODEX_TIMEOUT_CEILING_SECONDS = 600;
export const CODEX_SHORT_TIMEOUT_SECONDS = 3;
export const CODEX_SHORT_TIMEOUT_EVENTS: readonly string[] = ["SessionEnd", "Interrupt"];

/**
 * why `PermissionRequest` gets its own entry: it is a separate hook event with a separate response vocabulary,
 * and it is the only place a Codex escalation can be refused before the operator is prompted.
 *
 * why no entry for `PostCompact` or `Interrupt`: `codex.inbound.ts` maps neither to a `HarnessEventKind`, so
 * registering them would launch a process on every one and drop the payload. They are added by the change that
 * gives them a kind, not ahead of it.
 */
const ENTRY_SPECS: readonly EntrySpec[] = [
  { hookEvent: "SessionStart", handler: "session-start", timeoutSeconds: 10 },
  { hookEvent: "SessionEnd", handler: "session-end", timeoutSeconds: CODEX_SHORT_TIMEOUT_SECONDS },
  { hookEvent: "UserPromptSubmit", handler: "prompt-submit", timeoutSeconds: 5 },
  { hookEvent: "PreToolUse", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "PermissionRequest", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "PostToolUse", handler: "tool-after", timeoutSeconds: 10 },
  { hookEvent: "SubagentStart", handler: "subagent-start", timeoutSeconds: 5 },
  { hookEvent: "SubagentStop", handler: "subagent-stop", timeoutSeconds: 5 },
  { hookEvent: "Stop", handler: "stop", timeoutSeconds: 120 },
  { hookEvent: "PreCompact", handler: "compact-before", timeoutSeconds: 5 },
];

export function codexHooksPath(): string {
  return join(codexConfigDir(), "hooks.json");
}

/**
 * invariant: no `failClosed` and no `loopLimit`. `WiringEntry` carries both and the Codex schema has neither, so
 * they are never set here — a field the host does not read is a promise the wiring cannot keep. `matcher` is the
 * one optional field that does carry over, because the reference documents it as a regex over tool names.
 */
export function codexWiring(runtime: RuntimePaths): ProviderWiring<ProviderWiringKind> {
  const entries: WiringEntry[] = ENTRY_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command: "node",
    // why `--provider` and not detection: most Codex events carry no fingerprint at all — they are Claude's shape
    // exactly — so the launcher's hint channel is what routes them, and this is where that hint is set.
    args: [runtime.launcherPath, "--provider", CODEX_PROVIDER, spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
  }));

  return {
    target: codexHooksPath(),
    kind: "codex-hooks-json",
    strategy: "merge",
    entries,
  };
}

export type CodexHookCommand = { type: "command"; command: string; timeout: number };
export type CodexHookGroup = { matcher?: string; hooks: CodexHookCommand[] };
export type CodexHooks = Record<string, CodexHookGroup[]>;

export type CodexMergeSuccess = { ok: true; hooksText: string; changed: boolean };
export type CodexMergeFailure = { ok: false; error: string; block: string };
export type CodexMergeResult = CodexMergeSuccess | CodexMergeFailure;

const LAUNCHER_MARKER = "tlc-exec.mjs";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * why a single quoted string and not the `{ command, args }` exec form: the reference documents `command` as one
 * string on this host. The exec form the nearest host uses is not accepted here, and passing an array would leave
 * every hook unparsed ([/decisions/ad-123.md](/decisions/ad-123.md), correction 3).
 */
export function codexCommandString(entry: WiringEntry): string {
  return [entry.command, ...entry.args]
    .map((token) => (token.includes(" ") ? `"${token}"` : token))
    .join(" ");
}

export function isHarnessGroup(group: unknown): boolean {
  return JSON.stringify(group ?? null).includes(LAUNCHER_MARKER);
}

function desiredHooksFor(entries: readonly WiringEntry[]): CodexHooks {
  const hooks: CodexHooks = {};
  for (const entry of entries) {
    const group: CodexHookGroup = {
      ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
      hooks: [{ type: "command", command: codexCommandString(entry), timeout: entry.timeoutSeconds }],
    };
    hooks[entry.hookEvent] = [...(hooks[entry.hookEvent] ?? []), group];
  }
  return hooks;
}

/**
 * Merge, never replace: `hooks.json` is a shared file, so a group that does not name our launcher belongs to
 * someone else's tooling and is carried through untouched. Ours are replaced wholesale rather than appended to,
 * because appending leaves a stale copy behind when the launcher path changes and every hook then fires twice.
 *
 * A file that does not parse is left alone and reported. A broken `hooks.json` breaks the operator's whole host,
 * which is strictly worse than missing steering.
 */
export function mergeCodexHooks(
  existingText: string | null,
  entries: readonly WiringEntry[],
): CodexMergeResult {
  const desired = desiredHooksFor(entries);

  let document: Record<string, unknown> = {};
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
        error: "hooks.json root is not a JSON object",
        block: JSON.stringify({ hooks: desired }, null, 2),
      };
    }
    document = parsed;
  }

  const currentHooks = isPlainRecord(document.hooks) ? (document.hooks as CodexHooks) : {};
  const mergedHooks: CodexHooks = { ...currentHooks };
  let changed = false;

  for (const [hookEvent, groups] of Object.entries(desired)) {
    const existingGroups = Array.isArray(mergedHooks[hookEvent]) ? mergedHooks[hookEvent] : [];
    const foreign = existingGroups.filter((group) => !isHarnessGroup(group));
    const nextGroups = [...foreign, ...groups];
    if (JSON.stringify(existingGroups) !== JSON.stringify(nextGroups)) {
      changed = true;
    }
    mergedHooks[hookEvent] = nextGroups;
  }

  return { ok: true, hooksText: JSON.stringify({ ...document, hooks: mergedHooks }, null, 2), changed };
}

export function applyCodexWiring(hooksPath: string, entries: readonly WiringEntry[]): CodexMergeResult {
  const existingText = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : null;
  const result = mergeCodexHooks(existingText, entries);
  if (result.ok && result.changed) {
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(hooksPath, result.hooksText, "utf8");
  }
  return result;
}
