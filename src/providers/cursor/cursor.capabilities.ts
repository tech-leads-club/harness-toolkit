import type { ProviderCapabilities } from "../../contracts/index.ts";

export function cursorCapabilities(): ProviderCapabilities {
  return {
    enforcesHooks: true,
    askSupportedOn: ["shell.before", "mcp.before"],
    sessionEnv: true,
    nativeLoopCounter: true,
    dedicatedShellEvent: true,
    toolInputRewrite: true,
    // why: `updated_mcp_tool_output` is scoped to `afterMCPExecution` only — `afterShellExecution` and
    // `afterFileEdit` are documented as observation-only, with no equivalent field.
    toolOutputRewriteOn: ["mcp.after"],
    contextAtToolBefore: false,
    contextAtToolAfter: true,
    // why: the `stop` output schema carries `followup_message` and nothing else, so a context decision raised there
    // has no field to travel in. `followup_message` is not the fallback — it auto-submits.
    contextAtStop: false,
    // hazard: the field exists and is documented, and the hook log says "Merged 1 valid response(s)". It is still
    // dropped: Cursor staff called it "a bug on our side… a timing issue between when the hook runs and when the
    // composer handle is created" (forum thread 158452, 2026-04-20), and it was reported again against 3.14.7 on
    // 2026-08-02 with no changelog entry fixing it. `env` on the same payload arrives, because that is a different
    // code path ([/decisions/ad-050.md](/decisions/ad-050.md)).
    sessionStartContextReliable: false,
    toolOutputAtAfter: true,
    // hazard: found live — a real session's cost report read $0.0000 throughout. No hook payload this
    // adapter has observed carries a token field, and `transcript_path` is a plain message/tool-call
    // log with no usage field either ([/decisions/ad-142.md](/decisions/ad-142.md)). `true` made
    // `usageGenAi` skip its one real fallback for a host with nothing to read there either.
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: true,
  };
}
