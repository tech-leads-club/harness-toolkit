import { claudeProvider } from "./claude/index.ts";
import { cursorProvider } from "./cursor/index.ts";
import type { ProviderPort } from "./provider.port.ts";

export type ResolveResult = {
  provider: ProviderPort | null;
  ambiguous: boolean;
  matchedNames: readonly string[];
};

// invariant: detection order is registry order — deterministic, never re-sorted.
export const providers: ProviderPort[] = [cursorProvider, claudeProvider];

export function resolveFromRegistry(raw: unknown, registry: readonly ProviderPort[]): ResolveResult {
  const matched = registry.filter((provider) => provider.detect(raw));
  if (matched.length === 0) {
    return { provider: null, ambiguous: false, matchedNames: [] };
  }
  return {
    provider: matched[0] ?? null,
    ambiguous: matched.length > 1,
    matchedNames: matched.map((provider) => provider.name),
  };
}

export function resolveProvider(raw: unknown): ResolveResult {
  return resolveFromRegistry(raw, providers);
}

/**
 * Resolution by name, for a host whose payload carries no fingerprint of its own.
 *
 * why this exists at all: a host can emit another host's payload shape byte for byte. Detection by content is then
 * not merely hard, it is impossible, and no registry ordering fixes it — the only sound answer is for the wiring
 * that launched the hook to say which host it belongs to.
 *
 * invariant: no detector runs. A hint that reached a detector could still lose to a provider earlier in the
 * registry, which would make the hint advisory — and an advisory hint is the failure this exists to prevent.
 *
 * invariant: an unmatched hint resolves to nothing. It never falls back to detection, because a hint that names a
 * host the registry does not have is a wiring fault, and answering it with a guess hands the payload to an adapter
 * that will parse it into an event with fields quietly absent. No hook firing is the better failure.
 */
export function resolveByHint(hint: string, registry: readonly ProviderPort[]): ResolveResult {
  const provider = registry.find((candidate) => candidate.name === hint) ?? null;
  return {
    provider,
    ambiguous: false,
    matchedNames: provider ? [provider.name] : [],
  };
}
