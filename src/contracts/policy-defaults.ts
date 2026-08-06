import type { EffortLevel } from "./effort.ts";

/**
 * hazard: this carried `allowedModels`, and an empty project list fell back to it — so a spawn could be refused by
 * a list the operator never wrote, which had already gone stale. `blockedPatterns` stays because it is the opposite
 * mechanism: it is concatenated with the project's rather than replacing it, and what it carries is the `-fast`
 * denial the rail exists for ([/decisions/ad-053.md](/decisions/ad-053.md)).
 */
export type ProviderPolicyDefaults = {
  blockedPatterns: string[];
  minEffort: EffortLevel | null;
  /** Tool names whose results carry content from outside the repository. */
  untrustedTools: string[];
};
