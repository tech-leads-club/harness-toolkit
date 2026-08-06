import type { ProviderPolicyDefaults } from "../../contracts/index.ts";

export function cursorPolicyDefaults(): ProviderPolicyDefaults {
  return {
    blockedPatterns: ["-fast(?:$|[^a-z0-9])", "/fast(?:$|[^a-z0-9])", "composer-2\\.5-fast"],
    minEffort: null,
    untrustedTools: ["Fetch", "WebSearch"],
  };
}
