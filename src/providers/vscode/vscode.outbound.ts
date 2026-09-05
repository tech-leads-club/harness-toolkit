import type { Decision, HarnessEvent, HarnessEventKind, Rendered } from "../../contracts/index.ts";

/**
 * The hook name to echo back when the payload does not carry one.
 *
 * why a full map rather than a lookup on `raw`: `hookEventName` is part of the response the host reads, and a
 * `Record<HarnessEventKind, string>` makes a new kind a compile error here instead of an `undefined` on the wire.
 *
 * why four entries are unreachable: VS Code documents no session-end, tool-failure, message-display or thought
 * event, so `vscode.inbound.ts` maps nothing to `session.end`, `tool.failure`, `response.after` or
 * `thought.after`. They exist because the map is exhaustive, not because the host fires them.
 */
const HOOK_EVENT_NAME_BY_KIND: Record<HarnessEventKind, string> = {
  "session.start": "SessionStart",
  "session.end": "Stop",
  "prompt.submit": "UserPromptSubmit",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
  "tool.failure": "PostToolUse",
  "shell.before": "PreToolUse",
  "shell.after": "PostToolUse",
  "mcp.before": "PreToolUse",
  "mcp.after": "PostToolUse",
  "read.before": "PreToolUse",
  "edit.after": "PostToolUse",
  "subagent.start": "SubagentStart",
  "subagent.stop": "SubagentStop",
  stop: "Stop",
  "compact.before": "PreCompact",
  "response.after": "Stop",
  "thought.after": "Stop",
};

const SESSION_START = "SessionStart";

const SILENT: Rendered = { stdout: null, exitCode: 0 };

function hookEventNameFor(event: HarnessEvent): string {
  // why both spellings: the payload arrives in either format (`vscode.inbound.ts`), and the name echoed back has
  // to be the host's own, not a reconstruction that happens to agree.
  const declared = event.raw.hook_event_name ?? event.raw.hookEventName;
  return typeof declared === "string" && declared.length > 0
    ? declared
    : HOOK_EVENT_NAME_BY_KIND[event.event];
}

function renderPermission(
  permissionDecision: "allow" | "deny" | "ask",
  hookEventName: string,
  reason: string | undefined,
): string {
  const hookSpecificOutput: Record<string, unknown> = { hookEventName, permissionDecision };
  if (reason !== undefined) {
    hookSpecificOutput.permissionDecisionReason = reason;
  }
  return JSON.stringify({ hookSpecificOutput });
}

export function vscodeRender(decision: Decision, event: HarnessEvent): Rendered {
  const hookEventName = hookEventNameFor(event);
  switch (decision.kind) {
    case "abstain":
      return SILENT;
    /**
     * `PreToolUse` is the only event the VS Code page documents as returning
     * `hookSpecificOutput.permissionDecision`, and it takes all three verdicts — which is what
     * `askSupportedOn` lists the four before-kinds for (spec P4 AC4, [/decisions/ad-125.md](/decisions/ad-125.md)).
     *
     * why a refusal is still emitted on the other events, where context is not: the host offers no second channel
     * for a refusal, and dropping one lets through the exact action a rail refused. Dropping context costs a note
     * nobody reads. The asymmetry is the reason the two branches differ.
     */
    case "allow":
      return { stdout: renderPermission("allow", hookEventName, undefined), exitCode: 0 };
    case "deny":
      return { stdout: renderPermission("deny", hookEventName, decision.reason), exitCode: 0 };
    case "ask":
      return { stdout: renderPermission("ask", hookEventName, decision.reason), exitCode: 0 };
    /**
     * invariant: context rides `hookSpecificOutput.additionalContext` at `SessionStart` and nowhere else. The
     * VS Code page documents that field on that event alone, and GitHub's Copilot reference states outright that
     * `preToolUse` does not return it — so `contextAtToolBefore`, `contextAtToolAfter` and `contextAtStop` are all
     * false and `degrade()` strips those three before this function runs.
     *
     * why the branch exists anyway: `degrade()` gates context only on those three kinds, so a context decision at
     * `shell.before`, `read.before` or `edit.after` reaches here intact. Rendering it into a field this host
     * ignores would leave the caller believing it was delivered, which is the defect
     * [/decisions/ad-050.md](/decisions/ad-050.md) records. Silence is the honest answer.
     */
    case "context":
      return hookEventName === SESSION_START
        ? {
            stdout: JSON.stringify({
              hookSpecificOutput: { hookEventName, additionalContext: decision.text },
            }),
            exitCode: 0,
          }
        : SILENT;
    /**
     * hazard: the one unverified field pair in this adapter. The VS Code page's common stop outputs are
     * `continue`, `stopReason` and `systemMessage`; GitHub's Copilot reference documents `decision` with a
     * `reason` for the same event. This emits the second, because it is the shape that hands text back *and*
     * keeps the turn going, and it is what the host whose payload shape this reuses reads. If the name is wrong
     * the advisory is dropped and the turn simply ends, which is the direction that fails visibly.
     */
    case "continue":
      return { stdout: JSON.stringify({ decision: "block", reason: decision.text }), exitCode: 0 };
    /**
     * why a rewrite renders as silence: `toolInputRewrite` is false — the VS Code page documents a permission
     * decision on `PreToolUse` and no argument substitution, and the `modifiedArgs` in the Copilot reference is
     * the Copilot CLI's field ([/decisions/ad-125.md](/decisions/ad-125.md)). `degrade()` turns a rewrite into an ask on this host, which the four
     * before-kinds do support, so this branch is what a caller that skipped `degrade()` falls to. Emitting an
     * undocumented field would claim a channel the descriptor denies, and the tool would run its original input
     * either way.
     */
    case "rewriteInput":
      return SILENT;
    default: {
      const exhaustive: never = decision;
      throw new Error(`unreachable decision kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
