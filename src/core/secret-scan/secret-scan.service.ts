export type SecretMatch = {
  start: number;
  end: number;
  kind: string;
};

// invariant: shaped like the real thing, never the real thing — a signature fixture that could pass for a working
// credential in its own test file would be the exact leak this module exists to catch.
export const SIGNATURES: Record<string, RegExp> = {
  "aws-access-key": /\bAKIA[0-9A-Z]{16}\b/g,
  "github-token": /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
  "slack-token": /\bxox[baprs]-[0-9A-Za-z-]{10,72}\b/g,
  "stripe-key": /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
  "pem-private-key": /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  jwt: /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\b/g,
};

// why: a run of the base64/hex/token alphabet, long enough to be worth an entropy check at all. Excluding `-` keeps
// a dash-separated UUID out of this pattern entirely — each of its five segments is shorter than the minimum length
// below, so it never reaches the entropy test in the first place.
const ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9+/_=]{20,}/g;

/**
 * why these numbers: measured against this module's own fixtures (see `__test__`) — a 40-character git commit SHA
 * scores ~3.8 bits/char (hex alphabet), a hand-picked high-diversity secret-shaped string scores 5.0. 4.5 sits
 * between them, so a hex-alphabet identifier stays out of the false-positive path while a genuinely high-diversity
 * token still crosses it. The 20-character floor keeps a short common token from crossing it by chance alone.
 */
export const ENTROPY_THRESHOLD = 4.5;
export const ENTROPY_MIN_LENGTH = 20;

export function shannonEntropy(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const ch of text) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function signatureMatches(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const [kind, pattern] of Object.entries(SIGNATURES)) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined) {
        continue;
      }
      matches.push({ start: match.index, end: match.index + match[0].length, kind });
    }
  }
  return matches;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

// why: a signature match (an AWS key, a JWT segment) is already high-entropy by construction, so scanning it
// again here would report the same secret as two separate spans — checked against `existing` before this runs.
function entropyMatches(text: string, existing: readonly SecretMatch[]): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const match of text.matchAll(ENTROPY_TOKEN_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const span = { start: match.index, end: match.index + match[0].length };
    if (existing.some((existingMatch) => overlaps(span, existingMatch))) {
      continue;
    }
    if (span.end - span.start < ENTROPY_MIN_LENGTH) {
      continue;
    }
    if (shannonEntropy(match[0]) > ENTROPY_THRESHOLD) {
      matches.push({ ...span, kind: "entropy" });
    }
  }
  return matches;
}

// invariant: pure — no I/O, no network call, no subprocess. Every input is a string already in memory.
export function scanForSecrets(text: string | undefined): SecretMatch[] {
  if (!text) {
    return [];
  }
  const signature = signatureMatches(text);
  const entropy = entropyMatches(text, signature);
  return [...signature, ...entropy].sort((a, b) => a.start - b.start);
}
