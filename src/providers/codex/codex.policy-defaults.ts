import type { ProviderPolicyDefaults } from "../../contracts/index.ts";

/**
 * why `WebSearch` alone: `untrustedTools` names the tools whose results carry content from outside the repository,
 * spelled the way the host spells them. `WebSearch` is the one such tool the source transcription records for
 * Codex; Claude's `WebFetch` and Cursor's `Fetch` are those hosts' names for their own tools and do not transfer.
 *
 * hazard: the transcription also records that `WebSearch` never reaches the hook pipeline on Codex v1
 * ([/decisions/ad-123.md](/decisions/ad-123.md), "Not decided here"). So this entry is correct and currently
 * unenforceable — it takes effect the day the gap closes, and dropping it would mean noticing that day by hand.
 *
 * why no blocked pattern: `blockedPatterns` names model identifiers a spawn must not be routed to. Cursor ships
 * three because a measured fast-tier alias exists there. Nothing equivalent is documented for Codex, and a pattern
 * invented here would refuse a model nobody has evidence against.
 */
export function codexPolicyDefaults(): ProviderPolicyDefaults {
  return {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: ["WebSearch"],
  };
}
