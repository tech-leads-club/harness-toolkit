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

type VSCodeHookCommand = { type: "command"; command: string; timeout: number };

/**
 * why a single quoted line and not the `{ command, args }` exec form: the published hooks reference documents
 * `command` as one shell command line
 * (<https://code.visualstudio.com/docs/agents/reference/hooks-reference>, read 2026-09-05). An array here would
 * leave every hook unparsed.
 *
 * invariant: any token carrying whitespace or a quote is double-quoted and its backslashes and quotes escaped.
 * The launcher path is the token that varies per machine, and a home directory with a space in it is the case
 * that turns a working install into a hook that runs the wrong file.
 */
export function vscodeCommandString(entry: WiringEntry): string {
  return [entry.command, ...entry.args]
    .map((token) =>
      /[\s"\\]/.test(token) ? `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : token,
    )
    .join(" ");
}

/**
 * The document this writer would put at `~/.copilot/hooks/tlc-harness.json`.
 *
 * why flat, with no group wrapper: the published reference maps each event to an array of command objects
 * directly. The group nesting this once emitted is the shape of the host whose *payloads* VS Code reuses, and it
 * was a guess made while the schema was unpublished.
 *
 * why no `matcher`: quoted verbatim from that reference — "Currently, VS Code ignores matcher values, so hooks
 * run on all tool invocations regardless of the matcher". Emitting one would read as a filter that is doing
 * something.
 */
function renderVSCodeHooksDocument(entries: readonly WiringEntry[]): {
  hooks: Record<string, VSCodeHookCommand[]>;
} {
  const hooks: Record<string, VSCodeHookCommand[]> = {};
  for (const entry of entries) {
    // why `timeout` is emitted on every entry: the documented default is 30 seconds, which is a quarter of what
    // `Stop` needs and six times what the cheap events want. `WiringEntry` carries the per-event number and
    // dropping it here would hand all eight hooks the same 30.
    const command: VSCodeHookCommand = {
      type: "command",
      command: vscodeCommandString(entry),
      timeout: entry.timeoutSeconds,
    };
    hooks[entry.hookEvent] = [...(hooks[entry.hookEvent] ?? []), command];
  }
  return { hooks };
}

export function renderVSCodeHooksText(entries: readonly WiringEntry[]): string {
  return `${JSON.stringify(renderVSCodeHooksDocument(entries), null, 2)}\n`;
}

/**
 * why nothing writes that document: AD-126 rested on two facts and only one of them has since been settled.
 * The file shape above is the vendor's rather than a guess; Agent Hooks are still Preview, and the reference
 * says so in its own words — "The configuration format and behavior might change in future releases".
 * Dispatching this writer would put a file an operator did not ask for on a host that reads
 * `.claude/settings.json` by default and is therefore already running Claude's wiring against its own tool
 * names (T19's hazard).
 *
 * invariant: the adapter is complete and the writer is tested. What is deferred is the *dispatch*, so the day
 * Agent Hooks reach GA the change is deleting a branch, not writing an adapter
 * ([/decisions/ad-126.md](/decisions/ad-126.md), spec P4 AC5).
 */
export const VSCODE_DEFERRAL_REASON =
  "deferred while VS Code Agent Hooks are Preview — the vendor states the configuration format and behavior might change, the adapter is complete and tested, so nothing is written (docs/decisions/ad-126.md)";

export function isDeferredWiringKind(kind: string): boolean {
  return kind === VSCODE_WIRING_KIND;
}
