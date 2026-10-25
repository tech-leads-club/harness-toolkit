import { claudeProvider } from "./claude/index.ts";
import { codexProvider } from "./codex/index.ts";
import { cursorProvider } from "./cursor/index.ts";
import type { ProviderPort } from "./provider.port.ts";

export type ResolveResult = {
  provider: ProviderPort | null;
  ambiguous: boolean;
  matchedNames: readonly string[];
};

// invariant: detection order is registry order — deterministic, never re-sorted.
export const providers: ProviderPort[] = [cursorProvider, claudeProvider, codexProvider];

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
