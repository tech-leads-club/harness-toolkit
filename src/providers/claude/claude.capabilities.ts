import type { ProviderCapabilities } from "../../contracts/index.ts";

export function claudeCapabilities(): ProviderCapabilities {
  return {
    enforcesHooks: true,
    askSupportedOn: ["tool.before", "shell.before", "mcp.before", "read.before"],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: true,
    // why: `updatedToolOutput` is documented on every event this adapter fires PostToolUse/PostToolUseFailure
    // for — both of the after-events a rewrite could ever apply to.
    toolOutputRewriteOn: ["tool.after", "tool.failure"],
    contextAtToolBefore: true,
    contextAtToolAfter: true,
    // why: `Stop` accepts `hookSpecificOutput.additionalContext` for feedback that continues the turn, which is
    // exactly what a non-blocking gate advisory is.
    contextAtStop: true,
    // why: `SessionStart` delivers `hookSpecificOutput.additionalContext`, capped at 10,000 characters. Only that
    // field — a top-level `additional_context` is read as well and not deduplicated, so emitting both injects twice.
    sessionStartContextReliable: true,
    toolOutputAtAfter: true,
    usageInPayload: false,
    effortSignal: true,
    thoughtEvent: false,
  };
}
