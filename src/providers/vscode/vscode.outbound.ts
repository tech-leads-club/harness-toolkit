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

const PRE_TOOL_USE = "PreToolUse";
const POST_TOOL_USE = "PostToolUse";
const STOP = "Stop";
const SUBAGENT_STOP = "SubagentStop";

/**
 * The four events whose output the published reference documents as accepting
 * `hookSpecificOutput.additionalContext`, and no others
 * (<https://code.visualstudio.com/docs/agents/reference/hooks-reference>, read 2026-09-05).
 */
const CONTEXT_EVENTS = new Set([PRE_TOOL_USE, POST_TOOL_USE, "SessionStart", "SubagentStart"]);

/**
 * The events that document `decision: "block"` with a `reason` **top-level**. `Stop` documents the same pair
 * one level down, inside `hookSpecificOutput`, which is why the two placements are separate branches below.
 */
const TOP_LEVEL_BLOCK_EVENTS = new Set([POST_TOOL_USE, SUBAGENT_STOP]);

const SILENT: Rendered = { stdout: null, exitCode: 0 };

function hookEventNameFor(event: HarnessEvent): string {
  // why both spellings: the payload arrives in either format (`vscode.inbound.ts`), and the name echoed back has
  // to be the host's own, not a reconstruction that happens to agree.
  const declared = event.raw.hook_event_name ?? event.raw.hookEventName;
  return typeof declared === "string" && declared.length > 0
    ? declared
    : HOOK_EVENT_NAME_BY_KIND[event.event];
}

/**
 * invariant: emitted on `PreToolUse` and nowhere else. The reference states `permissionDecision` and
 * `permissionDecisionReason` are exclusive to that event, so the same object on any other event is read by
 * nothing — which is the defect [/decisions/ad-050.md](/decisions/ad-050.md) records, not a fallback.
 */
function renderPermission(
  permissionDecision: "allow" | "deny" | "ask",
  hookEventName: string,
  reason: string | undefined,
): Rendered {
  if (hookEventName !== PRE_TOOL_USE) {
    // hazard: a refusal raised at any other event has no channel this host honours, so it is dropped and the
    // action it refused proceeds. The events that document `decision: "block"` carry a stop advisory rather
    // than a permission verdict, and routing a refusal through one would be inventing a rail
    // ([/decisions/ad-125.md](/decisions/ad-125.md)).
    return SILENT;
  }
  const hookSpecificOutput: Record<string, unknown> = { hookEventName, permissionDecision };
  if (reason !== undefined) {
    hookSpecificOutput.permissionDecisionReason = reason;
  }
  return { stdout: JSON.stringify({ hookSpecificOutput }), exitCode: 0 };
}

export function vscodeRender(decision: Decision, event: HarnessEvent): Rendered {
  const hookEventName = hookEventNameFor(event);
  switch (decision.kind) {
    case "abstain":
      return SILENT;
    /**
     * why all three verdicts go through one function: `PreToolUse` is the only event whose hook may return
     * `permissionDecision`, and it takes `allow`, `deny` and `ask` alike — which is what `askSupportedOn` lists
     * the four before-kinds for (spec P4 AC4, [/decisions/ad-125.md](/decisions/ad-125.md)).
     */
    case "allow":
      return renderPermission("allow", hookEventName, undefined);
    case "deny":
      return renderPermission("deny", hookEventName, decision.reason);
    case "ask":
      return renderPermission("ask", hookEventName, decision.reason);
    /**
     * invariant: context rides `hookSpecificOutput.additionalContext` on the four events the reference lists
     * for it, and nowhere else. Rendering it into a field this host ignores would leave the caller believing it
     * was delivered ([/decisions/ad-050.md](/decisions/ad-050.md)); silence is the honest answer.
     */
    case "context":
      return CONTEXT_EVENTS.has(hookEventName)
        ? {
            stdout: JSON.stringify({
              hookSpecificOutput: { hookEventName, additionalContext: decision.text },
            }),
            exitCode: 0,
          }
        : SILENT;
    /**
     * why one pair and two placements: the reference documents `decision: "block"` with a `reason` top-level on
     * `PostToolUse` and `SubagentStop`, and one level down inside `hookSpecificOutput` — beside
     * `hookEventName` — on `Stop`. Emitting the wrong placement drops the advisory and ends the turn.
     */
    case "continue": {
      if (hookEventName === STOP) {
        return {
          stdout: JSON.stringify({
            hookSpecificOutput: { hookEventName, decision: "block", reason: decision.text },
          }),
          exitCode: 0,
        };
      }
      // hazard: an advisory raised anywhere else is dropped. No other event documents a channel that hands text
      // back and keeps the turn going, and the common `systemMessage` is shown to the operator, not the model.
      return TOP_LEVEL_BLOCK_EVENTS.has(hookEventName)
        ? { stdout: JSON.stringify({ decision: "block", reason: decision.text }), exitCode: 0 }
        : SILENT;
    }
    /**
     * hazard: `updatedInput` is emitted alone, as the host whose payload shape this reuses does. Codex errors
     * unless `permissionDecision: "allow"` rides with it, and the VS Code reference documents both fields on
     * this event without saying whether either requires the other. If the pairing turns out to be required, the
     * rewrite is ignored and the tool runs its original input.
     */
    case "rewriteInput":
      return hookEventName === PRE_TOOL_USE
        ? {
            stdout: JSON.stringify({
              hookSpecificOutput: { hookEventName, updatedInput: decision.input },
            }),
            exitCode: 0,
          }
        : SILENT;
    default: {
      const exhaustive: never = decision;
      throw new Error(`unreachable decision kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
