import type { ProviderCapabilities } from "../../contracts/index.ts";

/**
 * why two descriptors and not one with a branch: `capabilities()` takes no arguments, so a single opencode
 * adapter would have to either claim an ask channel the legacy plugin API cannot honour or discard the one the
 * namespaced API offers. Every value below is cited per generation in
 * [/decisions/ad-146.md](/decisions/ad-146.md), and no value is carried sideways between the two.
 */
export function opencodeLegacyCapabilities(): ProviderCapabilities {
  return {
    enforcesHooks: true,
    // why: the legacy reference has `permission.asked` and `permission.replied` — notifications of a decision
    // already taken — and no hook that returns one. `degrade()` turns an ask rule into a deny for this adapter.
    askSupportedOn: [],
    sessionEnv: false,
    // why: the flag claims a turn *count*, which `effectiveLoopCount` reads as a number. No opencode payload
    // carries one, so the harness counts turns itself.
    nativeLoopCounter: false,
    // why: shell arrives as `tool.execute.before` with `tool: "bash"`. `shell.env` sets a shell's environment and
    // intercepts nothing.
    dedicatedShellEvent: false,
    // why: the reference shows `output.args.command` and `output.args.filePath` as mutable at
    // `tool.execute.before`.
    toolInputRewrite: true,
    // hazard: empty because the emitted bridge discards the decision on `tool.execute.after`, not because the host
    // cannot do it. This flag now routes the secret mask: naming an event here that the bridge does not write
    // would drop the mask and the fallback notice together. Members are added by the change that writes them.
    toolOutputRewriteOn: [],
    // why: measured — the bridge appends a context decision to `output.context`.
    contextAtToolBefore: true,
    contextAtToolAfter: false,
    contextAtStop: false,
    // why: measured as unreliable, which is why this host carries lessons through a durable view instead.
    sessionStartContextReliable: false,
    toolOutputAtAfter: false,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  };
}

export function opencodeNamespacedCapabilities(): ProviderCapabilities {
  return {
    // why: `permission.evaluate` documents `effect: "deny"` as final, so a refusal here stops the action.
    enforcesHooks: true,
    /**
     * why: `ctx.permission.hook("evaluate")` accepts `effect: "ask"`, which prompts the operator. The reference
     * scopes the hook to no tool class, so it is declared across every before-kind this adapter raises.
     *
     * hazard: *which* tools reach a permission decision is undocumented. If opencode never routes a `read`
     * through permission evaluation, an ask rule on `read.before` prompts nobody and reports nothing
     * ([/decisions/ad-146.md](/decisions/ad-146.md)).
     */
    askSupportedOn: ["shell.before", "mcp.before", "read.before", "tool.before"],
    sessionEnv: false,
    nativeLoopCounter: false,
    // why: `ctx.shell.hook("create.before")` intercepts shell execution separately from tool execution, carrying
    // `command`, `cwd`, `timeout`, `shell`, and `env`. The legacy API has no such hook.
    dedicatedShellEvent: true,
    // why: the namespaced reference shows this hook as `(event) => …` over `event.tool` and `event.input`, and
    // documents no mutation of it. Undocumented and unmeasured, so the safe value — the legacy `true` above is a
    // different API's evidence and does not transfer.
    toolInputRewrite: false,
    // hazard: the host documents the channel — `event.result = { ...event.result, … }` on a completed call — and
    // the emitted bridge uses it for context only. Empty until the bridge writes a rewrite there, so a masked
    // output degrades to a notice instead of vanishing.
    toolOutputRewriteOn: [],
    // why: the transcription's measurement was taken against the legacy bridge, so it stops at the API boundary.
    contextAtToolBefore: false,
    // why: the same mutable `event.result` is the carrier.
    contextAtToolAfter: true,
    contextAtStop: false,
    sessionStartContextReliable: false,
    // why: `execute.after` documents `event.status` of "completed" | "error" and `event.result`.
    toolOutputAtAfter: true,
    usageInPayload: false,
    // why: `session.model.request` shapes an outgoing call; it is not an effort signal on a dispatcher payload.
    effortSignal: false,
    thoughtEvent: false,
  };
}
