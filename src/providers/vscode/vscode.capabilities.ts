import type { ProviderCapabilities } from "../../contracts/index.ts";

/**
 * Every value below is cited in [/decisions/ad-125.md](/decisions/ad-125.md), which draws one line and holds it:
 * what a hook *receives* comes from GitHub's Copilot hooks reference, what a hook may *return and have honoured*
 * comes from VS Code's own Agent Hooks page. The Copilot reference's `modifiedArgs`, `modifiedResult` and
 * `additionalContext`-at-`postToolUse` belong to GitHub's CLI and cloud agent, so they settle nothing here.
 *
 * invariant: no value is carried across from Claude. This host reuses Claude's payload shape, which makes Claude's
 * descriptor the one most likely to be copied and the copy hardest to notice.
 */
export function vscodeCapabilities(): ProviderCapabilities {
  return {
    // why: hooks run synchronously and their stdout is read back; exit code 2 is a blocking error.
    enforcesHooks: true,
    /**
     * why exactly these four: `PreToolUse` is the only event documented as returning
     * `hookSpecificOutput.permissionDecision`, and it accepts `"allow" | "deny" | "ask"`. Those four kinds are
     * exactly what `PreToolUse` fans out to in `HarnessEventKind` (spec P4 AC2).
     */
    askSupportedOn: ["shell.before", "mcp.before", "read.before", "tool.before"],
    // why: unmeasured. The VS Code page documents no environment given to a hook command; the Copilot reference's
    // `GITHUB_COPILOT_API_TOKEN` / `COPILOT_AGENT_PROMPT` are the cloud agent's, not this host's.
    sessionEnv: false,
    /**
     * why false when `stop_hook_active` exists: the flag claims a turn *count*. `effectiveLoopCount` reads
     * `event.loopCount` as a number against `policy.grind.maxLoops`, and this field is a boolean — mapped in, the
     * cap is never reached and a grind loop never stops. Claude declares false on the same field.
     */
    nativeLoopCounter: false,
    // why: there is no shell event. Terminal execution arrives as `PreToolUse` with `tool_name:
    // "runTerminalCommand"`.
    dedicatedShellEvent: false,
    // why: unmeasured. The VS Code page documents a permission decision on `PreToolUse` and no argument
    // substitution. `modifiedArgs` is the Copilot CLI's.
    toolInputRewrite: false,
    // why: unmeasured, same split — the VS Code page documents no result replacement on `PostToolUse`.
    // `modifiedResult` is the Copilot CLI's.
    toolOutputRewrite: false,
    // why not merely conservative: both sources agree. The VS Code page documents `PreToolUse` output as a
    // permission decision, and the Copilot reference states outright that `preToolUse` does not return
    // `additionalContext`.
    contextAtToolBefore: false,
    // why: unmeasured. `additionalContext` on `postToolUse` is the Copilot reference's alone.
    contextAtToolAfter: false,
    // why: no context channel at `Stop`. The documented outputs are `continue`, `stopReason` and `systemMessage`,
    // and an operator-visible warning is not context to the model.
    contextAtStop: false,
    // why: the VS Code page documents `hookSpecificOutput.additionalContext` on `SessionStart`, so this is the
    // host's own output contract rather than a transfer. It is also why this host needs no durable lessons file.
    sessionStartContextReliable: true,
    // why: `PostToolUse` receives `tool_result` with `result_type` and `text_result_for_llm` — an input shape, so
    // the Copilot reference settles it, and the fixtures already carry it.
    toolOutputAtAfter: true,
    // why: no token or cost field appears in any documented payload on either page.
    usageInPayload: false,
    // why: no model or reasoning-effort field appears in any documented payload.
    effortSignal: false,
    // why: neither source lists a thought or reasoning event.
    thoughtEvent: false,
  };
}
