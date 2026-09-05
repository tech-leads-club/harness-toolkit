import { claudeProvider } from "./claude/index.ts";
import { codexProvider } from "./codex/index.ts";
import { cursorProvider } from "./cursor/index.ts";
import { opencodeLegacyProvider, opencodeNamespacedProvider } from "./opencode/index.ts";
import type { ProviderPort } from "./provider.port.ts";
import { vscodeProvider } from "./vscode/index.ts";

export type ResolveResult = {
  provider: ProviderPort | null;
  ambiguous: boolean;
  matchedNames: readonly string[];
};

/**
 * invariant: detection order is registry order — deterministic, never re-sorted.
 *
 * why the two opencode adapters can sit anywhere in it: both match on a marker their own bridge stamps, and the
 * generation stamp makes them mutually exclusive, so neither can shadow the other or claim a foreign payload
 * ([/decisions/ad-124.md](/decisions/ad-124.md)). Order matters only for the hosts that share a payload shape.
 *
 * why Codex sits ahead of Claude: its payloads are a superset-shaped sibling of Claude's, so ordered after Claude
 * a Codex `PreToolUse` would be claimed by Claude's detector first (design §4). Claude also declines a
 * Codex-fingerprinted payload outright, so the two never both match and the order is belt to that brace.
 *
 * why VS Code's position is inert: its detector fires only on the hint, and a hint bypasses this list entirely
 * (`resolveByHint`). It sits ahead of Claude for readability, and because that is where a content-based detector
 * would have to go if one ever becomes possible (design §4).
 */
export const providers: ProviderPort[] = [
  cursorProvider,
  opencodeLegacyProvider,
  opencodeNamespacedProvider,
  codexProvider,
  vscodeProvider,
  claudeProvider,
];

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
