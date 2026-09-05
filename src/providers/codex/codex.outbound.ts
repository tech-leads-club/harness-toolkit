import type { Decision, HarnessEvent, HarnessEventKind, Rendered } from "../../contracts/index.ts";

/**
 * The hook name to echo back when the payload does not carry one.
 *
 * why a full map rather than a lookup on `raw`: `hookEventName` is part of the response Codex reads, and a
 * `Record<HarnessEventKind, string>` makes a new kind a compile error here instead of an `undefined` on the wire.
 *
 * why `response.after` and `thought.after` are here at all: no Codex event produces either kind
 * (`codex.inbound.ts` maps nothing to them, and `thoughtEvent` is false), so these two entries are unreachable.
 * They exist because the map is exhaustive.
 */
const HOOK_EVENT_NAME_BY_KIND: Record<HarnessEventKind, string> = {
  "session.start": "SessionStart",
  "session.end": "SessionEnd",
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

const PERMISSION_REQUEST = "PermissionRequest";

const SILENT: Rendered = { stdout: null, exitCode: 0 };

function hookEventNameFor(event: HarnessEvent): string {
  const declared = event.raw.hook_event_name;
  return typeof declared === "string" && declared.length > 0
    ? declared
    : HOOK_EVENT_NAME_BY_KIND[event.event];
}

function renderPermission(
  permissionDecision: "allow" | "deny",
  hookEventName: string,
  reason: string | undefined,
): string {
  const hookSpecificOutput: Record<string, unknown> = { hookEventName, permissionDecision };
  if (reason !== undefined) {
    // hazard: the reference documents `permissionDecision` on this event and this is its companion reason field,
    // carried from the shape Codex's `PreToolUse` mirrors. Unverified against a running host — if the name is
    // wrong, the refusal still lands and the operator sees a block with no explanation.
    hookSpecificOutput.permissionDecisionReason = reason;
  }
  return JSON.stringify({ hookSpecificOutput });
}

/**
 * `PermissionRequest` is deny-only, and everything else on it is silence.
 *
 * why: this event is Codex asking a human. Answering `allow` — or answering a rewrite, which implies one — turns
 * an escalation the operator was about to see into an automatic approval, with no error and no record. Silence
 * leaves Codex's own prompt in control, which is the outcome the harness wants for every verdict except a refusal
 * (spec P3 AC4, design §6).
 *
 * why the vocabulary differs from `PreToolUse`: the reference documents this event as taking
 * `hookSpecificOutput.decision.behavior` with a `message`, and resolves competing hooks by letting any deny win.
 * `permissionDecision` belongs to the other event and is not read here.
 */
function renderPermissionRequest(decision: Decision, hookEventName: string): Rendered {
  if (decision.kind !== "deny") {
    return SILENT;
  }
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        decision: { behavior: "deny", message: decision.reason },
      },
    }),
    exitCode: 0,
  };
}

export function codexRender(decision: Decision, event: HarnessEvent): Rendered {
  const hookEventName = hookEventNameFor(event);
  if (hookEventName === PERMISSION_REQUEST) {
    return renderPermissionRequest(decision, hookEventName);
  }

  switch (decision.kind) {
    case "abstain":
      return SILENT;
    case "allow":
      return { stdout: renderPermission("allow", hookEventName, undefined), exitCode: 0 };
    case "deny":
      return { stdout: renderPermission("deny", hookEventName, decision.reason), exitCode: 0 };
    /**
     * why an ask renders as a refusal: Codex parses `permissionDecision: "ask"` and runs the tool anyway
     * ([/decisions/ad-123.md](/decisions/ad-123.md)), so emitting it would approve the very action the rail wanted
     * escalated. `askSupportedOn: []` means `degrade()` already converts an ask to a deny before this function is
     * reached; this branch is what makes a caller that skipped `degrade()` fail safe rather than silently open.
     */
    case "ask":
      return { stdout: renderPermission("deny", hookEventName, decision.reason), exitCode: 0 };
    case "context":
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: decision.text } }),
        exitCode: 0,
      };
    // why: `Stop` and `PostToolUse` document `decision: "block"` with a `reason` as the channel that hands text
    // back and keeps the turn going.
    case "continue":
      return { stdout: JSON.stringify({ decision: "block", reason: decision.text }), exitCode: 0 };
    /**
     * invariant: `permissionDecision: "allow"` rides with `updatedInput`, never alone and never omitted. Codex
     * errors when `allow` is absent — the exact opposite of the host whose shape this mirrors, which omits it
     * (design §6, spec P3 AC5).
     */
    case "rewriteInput":
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName, permissionDecision: "allow", updatedInput: decision.input },
        }),
        exitCode: 0,
      };
    default: {
      const exhaustive: never = decision;
      throw new Error(`unreachable decision kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
