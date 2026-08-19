import type { ProviderCapabilities } from "../../contracts/index.ts";

export function cursorCapabilities(): ProviderCapabilities {
  return {
    enforcesHooks: true,
    askSupportedOn: ["shell.before", "mcp.before"],
    sessionEnv: true,
    nativeLoopCounter: true,
    dedicatedShellEvent: true,
    toolInputRewrite: true,
    toolOutputRewrite: true,
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
    usageInPayload: true,
    effortSignal: false,
    thoughtEvent: true,
  };
}
