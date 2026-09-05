import type { ProviderPolicyDefaults } from "../../contracts/index.ts";

/**
 * why the list is empty: `untrustedTools` names the tools whose results carry content from outside the repository,
 * spelled the way *this* host spells them. Neither source names one for VS Code — the tool vocabulary its hooks
 * page publishes is `runTerminalCommand`, `editFiles`, `createFile`, `deleteFile`, `pushToGitHub`, `create_file`
 * and `replace_string_in_file`. The `web_fetch` / `web_search` pair in GitHub's Copilot reference belongs to the
 * Copilot CLI, which is the product boundary [/decisions/ad-125.md](/decisions/ad-125.md) draws, and Claude's
 * `WebFetch` and Cursor's `Fetch` are those hosts' names for their own tools.
 *
 * A name invented here would match nothing, so the rail would look configured and gate nothing. Empty is the value
 * that fails visibly: the first capture that names a web tool adds it.
 *
 * why no blocked pattern: `blockedPatterns` names model identifiers a spawn must not be routed to. Cursor ships
 * three because a measured fast-tier alias exists there. Nothing equivalent is documented for VS Code.
 */
export function vscodePolicyDefaults(): ProviderPolicyDefaults {
  return {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: [],
  };
}
