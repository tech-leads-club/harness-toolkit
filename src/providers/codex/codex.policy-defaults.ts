import type { ProviderPolicyDefaults } from "../../contracts/index.ts";

export function codexPolicyDefaults(): ProviderPolicyDefaults {
  return {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: [],
  };
}
