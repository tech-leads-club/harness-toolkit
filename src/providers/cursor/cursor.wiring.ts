import { join } from "node:path";
import type { ProviderWiring, RuntimePaths, WiringEntry } from "../../contracts/index.ts";
import { cursorConfigDir } from "../../platform/paths.ts";

type EntrySpec = {
  hookEvent: string;
  handler: string;
  timeoutSeconds: number;
  failClosed?: boolean;
  matcher?: string;
  loopLimit?: number;
};

// why: mirrors bin/write-user-hooks.mjs verbatim — same hook keys, timeouts, failClosed/matcher/loopLimit values, and handler order.
const ENTRY_SPECS: readonly EntrySpec[] = [
  { hookEvent: "sessionStart", handler: "session-start", timeoutSeconds: 10 },
  { hookEvent: "sessionEnd", handler: "session-end", timeoutSeconds: 10 },
  { hookEvent: "beforeSubmitPrompt", handler: "prompt-submit", timeoutSeconds: 5 },
  { hookEvent: "afterAgentThought", handler: "tool-after", timeoutSeconds: 5 },
  { hookEvent: "preCompact", handler: "compact-before", timeoutSeconds: 5 },
  { hookEvent: "subagentStart", handler: "subagent-start", timeoutSeconds: 5, failClosed: true },
  { hookEvent: "subagentStop", handler: "subagent-stop", timeoutSeconds: 5 },
  { hookEvent: "preToolUse", handler: "tool-before", timeoutSeconds: 5, failClosed: true },
  { hookEvent: "postToolUse", handler: "tool-after", timeoutSeconds: 5 },
  { hookEvent: "postToolUseFailure", handler: "tool-failure", timeoutSeconds: 5 },
  { hookEvent: "beforeShellExecution", handler: "tool-before", timeoutSeconds: 10, failClosed: true },
  { hookEvent: "afterShellExecution", handler: "tool-after", timeoutSeconds: 10 },
  { hookEvent: "beforeMCPExecution", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "afterMCPExecution", handler: "tool-after", timeoutSeconds: 5 },
  { hookEvent: "beforeReadFile", handler: "tool-before", timeoutSeconds: 5 },
  { hookEvent: "afterFileEdit", handler: "tool-after", timeoutSeconds: 30, matcher: "Write" },
  { hookEvent: "stop", handler: "stop", timeoutSeconds: 120, loopLimit: 5 },
  { hookEvent: "afterAgentResponse", handler: "response-after", timeoutSeconds: 5, matcher: "AgentResponse" },
];

function commandFor(runtime: RuntimePaths): { command: string; argsPrefix: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd", argsPrefix: ["/c", "node", runtime.launcherPath] };
  }
  return { command: "node", argsPrefix: [runtime.launcherPath] };
}

export function cursorWiring(runtime: RuntimePaths): ProviderWiring {
  const { command, argsPrefix } = commandFor(runtime);
  const entries: WiringEntry[] = ENTRY_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command,
    args: [...argsPrefix, spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
    ...(spec.failClosed !== undefined ? { failClosed: spec.failClosed } : {}),
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
    ...(spec.loopLimit !== undefined ? { loopLimit: spec.loopLimit } : {}),
  }));

  return {
    target: join(cursorConfigDir(), "hooks.json"),
    strategy: "replace",
    entries,
  };
}

export type WiringProblem = { hookEvent: string; reason: string };

/**
 * hazard: splitting on whitespace broke a quoted path, and the writer quotes precisely because a path can contain
 * spaces — a macOS home under "Application Support" is an ordinary shape. A checker that mis-tokenises
 * reports a healthy wiring as broken, which is the failure mode that gets a check switched off.
 */
export function commandTokens(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

/**
 * hazard: health was decided by looking for one string. `isCursorWired` checks whether the file *contains*
 * `tlc-exec.mjs`, so a file carrying the marker in one entry and a broken command in another read as fully wired and
 * `doctor` said `wired`. Marker presence answers "is this file ours", which is the right question when deciding
 * whether to overwrite it and the wrong one when deciding whether the hooks work
 * ([/decisions/ad-032.md](/decisions/ad-032.md)).
 *
 * why: a colleague's session was blocked by a `preToolUse` whose command was a bare `node`, so Node read the hook
 * payload as a program. The entry was `failClosed`, so the crash blocked the tool rather than merely logging. Nothing
 * checked that a wired hook could run.
 *
 * invariant: only the events this provider declares are inspected, and within them only entries whose command names
 * our launcher. A hook belonging to another tool is not ours to judge, and flagging it would train an operator to
 * ignore the check.
 */
export function cursorWiringProblems(
  text: string | null,
  runtime: RuntimePaths,
  fileExists: (path: string) => boolean,
): WiringProblem[] {
  if (text === null) {
    return [{ hookEvent: "(file)", reason: "no hooks file at the expected path" }];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ hookEvent: "(file)", reason: "the hooks file is not valid JSON" }];
  }
  const hooks =
    parsed !== null && typeof parsed === "object"
      ? ((parsed as { hooks?: Record<string, unknown> }).hooks ?? {})
      : {};

  const problems: WiringProblem[] = [];
  for (const spec of ENTRY_SPECS) {
    const list = Array.isArray(hooks[spec.hookEvent]) ? (hooks[spec.hookEvent] as unknown[]) : [];
    const commands = list
      .map((row) =>
        row !== null && typeof row === "object" ? String((row as { command?: unknown }).command ?? "") : "",
      )
      // why: our entries are the ones naming our launcher. Everything else in the file belongs to someone else.
      .filter((command) => command.includes(runtime.launcherPath));
    if (commands.length === 0) {
      problems.push({ hookEvent: spec.hookEvent, reason: "no harness entry — run: tlc harness update" });
      continue;
    }
    for (const command of commands) {
      const tokens = commandTokens(command);
      const scriptAt = tokens.indexOf(runtime.launcherPath);
      if (scriptAt < 1) {
        problems.push({
          hookEvent: spec.hookEvent,
          reason: `no executable before the script: \`${command}\``,
        });
        continue;
      }
      if (!fileExists(runtime.launcherPath)) {
        problems.push({
          hookEvent: spec.hookEvent,
          reason: `the script does not exist: ${runtime.launcherPath}`,
        });
        continue;
      }
      if (tokens[scriptAt + 1] === undefined || tokens[scriptAt + 1] === "") {
        problems.push({
          hookEvent: spec.hookEvent,
          // why: the exact shape from the incident. A command with the script and no handler makes the launcher
          // exit 2 with usage, and a command with neither makes Node read the payload as a program.
          reason: `no handler after the script: \`${command}\``,
        });
      }
    }
  }
  return problems;
}

/** why: bounded, because a fresh install with no wiring produces one problem per declared event. */
export function formatWiringProblems(problems: readonly WiringProblem[], max = 3): string {
  const shown = problems
    .slice(0, max)
    .map((problem) => `${problem.hookEvent}: ${problem.reason}`)
    .join("; ");
  const rest = problems.length - Math.min(problems.length, max);
  return rest > 0 ? `${shown}; and ${rest} more` : shown;
}

export type CursorUnwire =
  | { kind: "absent" }
  | { kind: "unparsed" }
  | { kind: "empty"; removed: number }
  | { kind: "rewritten"; removed: number; text: string };

/**
 * The inverse of the document `bin/write-user-hooks.mjs` writes.
 *
 * invariant: an entry is ours when its command names the launcher — the same test `cursorWiringProblems` applies
 * one function above. `kind: "empty"` means every entry in the file was ours and the file itself can go; a file
 * that still holds somebody else's hook is rewritten without ours ([/decisions/ad-066.md](/decisions/ad-066.md)).
 */
export function unwireCursorHooks(text: string | null, marker = "tlc-exec.mjs"): CursorUnwire {
  if (text === null || text.trim() === "") {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unparsed" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unparsed" };
  }
  const document = parsed as { hooks?: unknown };
  const hooks =
    document.hooks !== null && typeof document.hooks === "object" && !Array.isArray(document.hooks)
      ? (document.hooks as Record<string, unknown>)
      : {};

  const remaining: Record<string, unknown[]> = {};
  let removed = 0;
  let kept = 0;
  for (const [hookEvent, value] of Object.entries(hooks)) {
    const list = Array.isArray(value) ? value : [];
    const foreign = list.filter((row) => !JSON.stringify(row ?? null).includes(marker));
    removed += list.length - foreign.length;
    if (foreign.length > 0) {
      remaining[hookEvent] = foreign;
      kept += foreign.length;
    }
  }

  if (kept === 0) {
    return { kind: "empty", removed };
  }
  return {
    kind: "rewritten",
    removed,
    text: `${JSON.stringify({ ...document, hooks: remaining }, null, 2)}\n`,
  };
}
