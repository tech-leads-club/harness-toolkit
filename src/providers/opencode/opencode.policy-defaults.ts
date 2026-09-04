import type { ProviderPolicyDefaults } from "../../contracts/index.ts";

/**
 * why: both generations run the same binary and the same tool set, so the defaults are shared even though the
 * capability descriptors are not. `webfetch` and `websearch` are opencode's own spellings for the two tools that
 * pull content the model did not write (opencode tools reference, read 2026-09-04).
 *
 * why the empty pattern list: `blockedPatterns` names model identifiers an operator should not be routed to.
 * Cursor ships three because a measured fast-tier alias exists there. Nothing equivalent is documented for
 * opencode, and a pattern invented here would refuse a model nobody has evidence against
 * ([/decisions/ad-124.md](/decisions/ad-124.md)).
 */
export function opencodePolicyDefaults(): ProviderPolicyDefaults {
  return {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: ["webfetch", "websearch"],
  };
}
