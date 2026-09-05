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
 * Whether a hook file at our target was written by this harness.
 *
 * why the launcher path and not a marker field: the published schema names every key a hook object may carry,
 * and a `_tlcHarness` of our own would be an undocumented field on a host that is explicit about the shape it
 * parses. The launcher is already in every `command` string we emit, so ownership is readable from what the
 * document has to contain anyway.
 *
 * invariant: an unparseable or foreign file answers false, so the writer refuses rather than overwriting it.
 */
export function isVSCodeManaged(text: string | null, launcherPath: string): boolean {
  if (text === null) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const hooks = (parsed as { hooks?: unknown })?.hooks;
    if (typeof hooks !== "object" || hooks === null) {
      return false;
    }
    const commands = Object.values(hooks as Record<string, unknown>).flatMap((group) =>
      Array.isArray(group) ? group : [],
    );
    return (
      commands.length > 0 &&
      commands.every(
        (entry) =>
          typeof (entry as { command?: unknown })?.command === "string" &&
          (entry as { command: string }).command.includes(launcherPath),
      )
    );
  } catch {
    return false;
  }
}

/**
 * why the project surface still defers while the user-level install writes: the two are not the same change.
 * `tlc harness install` had a rendered document, a target and an ownership rule already — dispatching it was
 * deleting a branch. The project shim has none of those: no presence probe for a workspace VS Code, and no
 * entry set pointing at a project launcher. Writing one now would be inventing a surface rather than enabling a
 * finished one.
 *
 * hazard: the schema half of AD-126 is settled and this text no longer claims otherwise. What remains is that
 * Agent Hooks are Preview, quoted from the reference — "The configuration format and behavior might change in
 * future releases" ([/decisions/ad-126.md](/decisions/ad-126.md)).
 */
export const VSCODE_DEFERRAL_REASON =
  "deferred for the project surface — the user-level hook file is written by `tlc harness install`; a workspace shim needs a presence probe and entry set that do not exist yet, and Agent Hooks remain Preview";
