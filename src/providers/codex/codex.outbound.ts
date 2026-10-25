import type { Decision, HarnessEvent, Rendered } from "../../contracts/index.ts";

const PRE_EVENTS = new Set(["tool.before", "shell.before", "mcp.before", "read.before"]);
const CONTEXT_HOOKS = new Set([
  "SessionStart",
  "SubagentStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
]);

export function codexRender(decision: Decision, event: HarnessEvent): Rendered {
  const hook = typeof event.raw.hook_event_name === "string" ? event.raw.hook_event_name : "PreToolUse";
  const pre = PRE_EVENTS.has(event.event);
  let output: Record<string, unknown> = {};
  switch (decision.kind) {
    case "abstain":
      break;
    case "allow":
      // why: silence preserves the host's normal approval policy.
      break;
    case "ask":
    case "deny":
      output = pre
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.reason,
            },
          }
        : event.event === "stop" || event.event === "subagent.stop" || event.event === "prompt.submit"
          ? { decision: "block", reason: decision.reason }
          : { systemMessage: decision.reason };
      break;
    case "continue":
      output = { decision: "block", reason: decision.text };
      break;
    case "context":
      if (CONTEXT_HOOKS.has(hook))
        output = { hookSpecificOutput: { hookEventName: hook, additionalContext: decision.text } };
      break;
    case "rewriteInput":
      if (pre)
        output = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: decision.input,
          },
        };
      break;
    case "rewriteOutput":
      break;
  }
  return { stdout: JSON.stringify(output), exitCode: 0 };
}
