import { join } from "node:path";
import type { ProviderWiring, RuntimePaths, WiringEntry } from "../../contracts/index.ts";
import { copilotConfigDir } from "../../platform/paths.ts";
import type { ProviderWiringKind } from "../provider.port.ts";
import { VSCODE_PROVIDER } from "./vscode.detect.ts";

type EntrySpec = { hookEvent: string; handler: string; timeoutSeconds: number };

/**
 * VS Code's documented event list, and only it: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
 * `PreCompact`, `SubagentStart`, `SubagentStop`, `Stop` ([/decisions/ad-125.md](/decisions/ad-125.md)).
 *
 * invariant: no `SessionEnd`, no `PostToolUseFailure`, no `MessageDisplay`. Those three are the host whose payload
 * shape this reuses, and wiring them here would register hooks VS Code never fires — the same list
 * `vscode.inbound.ts` is three rows shorter than Claude's for.
 */
const ENTRY_SPECS: readonly EntrySpec[] = [
  { hookEvent: "SessionStart", handler: "session-start", timeoutSeconds: 10 },
  { hookEvent: "UserPromptSubmit", handler: "prompt-submit", timeoutSeconds: 5 },
  { hookEvent: "PreToolUse", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "PostToolUse", handler: "tool-after", timeoutSeconds: 10 },
  { hookEvent: "SubagentStart", handler: "subagent-start", timeoutSeconds: 5 },
  { hookEvent: "SubagentStop", handler: "subagent-stop", timeoutSeconds: 5 },
  { hookEvent: "Stop", handler: "stop", timeoutSeconds: 120 },
  { hookEvent: "PreCompact", handler: "compact-before", timeoutSeconds: 5 },
];

const VSCODE_WIRING_KIND = "vscode-hooks-json";

export function vscodeHooksPath(): string {
  return join(copilotConfigDir(), "hooks", "tlc-harness.json");
}

/**
 * invariant: every entry launches with `--provider vscode`. This host has no content fingerprint at all — its
 * payload is Claude's byte for byte — so the hint the launcher reads out of these arguments is the only thing that
 * routes a hook to this adapter (`vscode.detect.ts`, spec P4 AC1).
 */
export function vscodeWiring(runtime: RuntimePaths): ProviderWiring<ProviderWiringKind> {
  const entries: WiringEntry[] = ENTRY_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command: "node",
    args: [runtime.launcherPath, "--provider", VSCODE_PROVIDER, spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
  }));

  return {
    target: vscodeHooksPath(),
    kind: "vscode-hooks-json",
    strategy: "replace",
    entries,
  };
}

type VSCodeHookCommand = { type: "command"; command: string; args: string[]; timeout: number };
type VSCodeHookGroup = { hooks: VSCodeHookCommand[] };

/**
 * The document this writer would put at `~/.copilot/hooks/tlc-harness.json`.
 *
 * hazard: the file *schema* is the one thing about this host neither source publishes. The VS Code page names the
 * discovery locations and the exit-code contract; it does not inline the hook file's own shape. What is emitted
 * here is the shape of the host whose payload format this reuses, which is the best-supported guess and still a
 * guess — and it is one of the two reasons this wiring is not dispatched
 * ([/decisions/ad-126.md](/decisions/ad-126.md)). A capture settles it, and until then the deferral means nobody
 * runs on the guess.
 */
function renderVSCodeHooksDocument(entries: readonly WiringEntry[]): {
  hooks: Record<string, VSCodeHookGroup[]>;
} {
  const hooks: Record<string, VSCodeHookGroup[]> = {};
  for (const entry of entries) {
    // why `timeout` is emitted although the host whose shape this borrows omits it: `WiringEntry` carries a
    // per-event timeout — 120 seconds on `Stop`, 5 on the cheap events — and dropping it here would silently
    // hand every hook whatever default the host picks. The field name shares the schema's uncertainty; the
    // number does not.
    const group: VSCodeHookGroup = {
      hooks: [{ type: "command", command: entry.command, args: entry.args, timeout: entry.timeoutSeconds }],
    };
    hooks[entry.hookEvent] = [...(hooks[entry.hookEvent] ?? []), group];
  }
  return { hooks };
}

export function renderVSCodeHooksText(entries: readonly WiringEntry[]): string {
  return `${JSON.stringify(renderVSCodeHooksDocument(entries), null, 2)}\n`;
}

/**
 * Why nothing writes that document.
 *
 * VS Code Agent Hooks are Preview. Two things follow, and either alone is enough: the payload format is not
 * frozen, and the hook *file* schema is not published at all. Dispatching this writer would put a file an
 * operator did not ask for at a path whose format is a guess, on a host that reads `.claude/settings.json` by
 * default and would therefore already be running Claude's wiring against its own tool names (T19's hazard).
 *
 * invariant: the adapter is complete and the writer is tested. What is deferred is the *dispatch*, so the day
 * Agent Hooks reach GA the change is deleting a branch, not writing an adapter
 * ([/decisions/ad-126.md](/decisions/ad-126.md), spec P4 AC5).
 */
export const VSCODE_DEFERRAL_REASON =
  "deferred while VS Code Agent Hooks are Preview — the adapter is complete and tested, and the hook file schema is not published, so nothing is written (docs/decisions/ad-126.md)";

export function isDeferredWiringKind(kind: string): boolean {
  return kind === VSCODE_WIRING_KIND;
}
