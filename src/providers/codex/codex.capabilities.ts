import type { ProviderCapabilities } from "../../contracts/index.ts";

/**
 * Every value below is cited in [/decisions/ad-123.md](/decisions/ad-123.md), against OpenAI's published Codex
 * hooks reference or a behaviour measured in the feature's source transcription. No value is carried across from
 * Claude or Cursor: a flag set by analogy does not fail loudly, it leaves a rail quietly doing nothing.
 */
export function codexCapabilities(): ProviderCapabilities {
  return {
    // why: every hook runs synchronously and its stdout is read back as a verdict.
    enforcesHooks: true,
    /**
     * why empty rather than the before-kinds Claude supports: the reference states `permissionDecision: "ask"` is
     * parsed but unsupported, and the transcription measured the same thing — Codex parses it and runs the tool
     * anyway. Declaring an ask channel here would convert every escalation into an approval, silently. `degrade()`
     * turns an ask rule into a deny for this host, so the rule author still writes one rule.
     */
    askSupportedOn: [],
    // why: `PLUGIN_ROOT` and `PLUGIN_DATA` are documented for plugin-bundled hooks only, and nothing is documented
    // for a `hooks.json` command. Silence takes the value that fails visibly.
    sessionEnv: false,
    /**
     * why false when `stop_hook_active` exists: the flag claims a turn *count*. `effectiveLoopCount` reads
     * `event.loopCount` as a number against `policy.grind.maxLoops`, and this field is a boolean — mapped in, it
     * yields at most 1 and the grind cap is never reached. AD-123 carries the correction; the adapter counts turns
     * itself, as Claude does.
     */
    nativeLoopCounter: false,
    // why: there is no shell event. Shell interception is `PreToolUse` with a `^Bash$` matcher.
    dedicatedShellEvent: false,
    // why: `PreToolUse` accepts `hookSpecificOutput.updatedInput` alongside `permissionDecision: "allow"`.
    toolInputRewrite: true,
    // why: `PostToolUse` accepts `decision: "block"`, `reason`, and `additionalContext`, and no field that replaces
    // what the tool returned.
    toolOutputRewrite: false,
    // why: `PreToolUse` accepts `hookSpecificOutput.additionalContext`.
    contextAtToolBefore: true,
    // why: `PostToolUse` accepts `hookSpecificOutput.additionalContext`.
    contextAtToolAfter: true,
    // why: `Stop` documents only `decision: "block"` with `reason`. No context channel.
    contextAtStop: false,
    /**
     * hazard: the least certain value in the table. `SessionStart` accepts `hookSpecificOutput.additionalContext`
     * and plain stdout is documented as added to developer context, corroborated by the transcription — but a host
     * can accept a field, report it merged, and drop it (`src/contracts/capabilities.ts:14`). If it turns out
     * false, lessons silently never reach a Codex session and the durable view has to carry them instead.
     */
    sessionStartContextReliable: true,
    // why: `PostToolUse` carries `tool_response`.
    toolOutputAtAfter: true,
    // why: no token or cost field appears in any documented payload.
    usageInPayload: false,
    // why: payloads carry `model`; no reasoning-effort field is documented.
    effortSignal: false,
    // why: no thought or reasoning event exists in the documented event list.
    thoughtEvent: false,
  };
}
