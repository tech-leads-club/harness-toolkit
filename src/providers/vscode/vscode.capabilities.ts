import type { ProviderCapabilities } from "../../contracts/index.ts";

/**
 * Every value below is cited in [/decisions/ad-125.md](/decisions/ad-125.md), which draws one line and holds it:
 * what a hook *receives* comes from GitHub's Copilot hooks reference, what a hook may *return and have honoured*
 * comes from VS Code's own Agent Hooks page. The Copilot reference's `modifiedArgs`, `modifiedResult` and
 * `additionalContext`-at-`postToolUse` belong to GitHub's CLI and cloud agent, so they settle nothing here.
 *
 * why three of them changed: VS Code has since published its own per-event hooks reference
 * (<https://code.visualstudio.com/docs/agents/reference/hooks-reference>, read 2026-09-05), which documents
 * `updatedInput` on `PreToolUse` and `additionalContext` on `PreToolUse` and `PostToolUse`. The rule above did
 * not change — the VS Code page simply now carries the fields (AD-125's correction section).
 *
 * invariant: no value is carried across from Claude. This host reuses Claude's payload shape, which makes Claude's
 * descriptor the one most likely to be copied and the copy hardest to notice.
 */
export function vscodeCapabilities(): ProviderCapabilities {
  return {
    // why: hooks run synchronously and their stdout is read back; exit code 2 is a blocking error.
    enforcesHooks: true,
    /**
     * why exactly these four and no others: `permissionDecision` is exclusive to `PreToolUse` in the published
     * reference, and it accepts `"allow" | "deny" | "ask"`. These four kinds are exactly the ones
     * `vscode.inbound.ts` produces from `PreToolUse` and the ones `vscode.outbound.ts` maps back to it — every
     * other kind maps to an event that ignores the field (spec P4 AC2).
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
    // why: the published hooks reference documents `hookSpecificOutput.updatedInput` as an optional object on
    // `PreToolUse`. This is VS Code's own page, not the Copilot CLI's `modifiedArgs`.
    toolInputRewrite: true,
    // why: unmeasured, same split — the VS Code page documents no result replacement on `PostToolUse`.
    // `modifiedResult` is the Copilot CLI's.
    toolOutputRewrite: false,
    // why: the published hooks reference lists `PreToolUse` among the four events that accept
    // `additionalContext`. That overrides the Copilot reference's claim that `preToolUse` does not return it.
    contextAtToolBefore: true,
    // why: `PostToolUse` is the second of the four events the published reference lists for `additionalContext`.
    contextAtToolAfter: true,
    // why still false: `Stop` is not in that list of four. Its documented outputs are `decision` with a `reason`
    // plus the common `continue`, `stopReason` and `systemMessage` — an operator-visible warning is not context
    // to the model.
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
