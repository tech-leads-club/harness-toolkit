import type { ProviderPolicyDefaults } from "../../contracts/index.ts";

export function claudePolicyDefaults(): ProviderPolicyDefaults {
  return {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: ["WebFetch", "WebSearch"],
  };
}
