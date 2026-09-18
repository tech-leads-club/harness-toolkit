import type { Decision, HarnessEvent, HarnessEventKind, Rendered } from "../../contracts/index.ts";

// why: Claude has no dedicated thought event (thoughtEvent: false) — this entry is never reached.
const HOOK_EVENT_NAME_BY_KIND: Record<HarnessEventKind, string> = {
  "session.start": "SessionStart",
  "session.end": "SessionEnd",
  "prompt.submit": "UserPromptSubmit",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
  "tool.failure": "PostToolUseFailure",
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
  "response.after": "MessageDisplay",
  "thought.after": "MessageDisplay",
};

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

export function claudeRender(decision: Decision, event: HarnessEvent): Rendered {
  const hookEventName = HOOK_EVENT_NAME_BY_KIND[event.event];
  switch (decision.kind) {
    case "abstain":
      return { stdout: null, exitCode: 0 };
    case "allow":
      return { stdout: renderPermission("allow", hookEventName, undefined), exitCode: 0 };
    case "deny":
      return { stdout: renderPermission("deny", hookEventName, decision.reason), exitCode: 0 };
    case "ask":
      return { stdout: renderPermission("ask", hookEventName, decision.reason), exitCode: 0 };
    case "context":
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: decision.text } }),
        exitCode: 0,
      };
    case "continue":
      return { stdout: JSON.stringify({ decision: "block", reason: decision.text }), exitCode: 0 };
    case "rewriteInput":
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, updatedInput: decision.input } }),
        exitCode: 0,
      };
    // why: the documented schema for updatedToolOutput places it at the top of the JSON, unlike every other
    // field this adapter emits — nesting it under hookSpecificOutput would not be read.
    case "rewriteOutput":
      return { stdout: JSON.stringify({ updatedToolOutput: decision.output }), exitCode: 0 };
    default: {
      const exhaustive: never = decision;
      throw new Error(`unreachable decision kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
