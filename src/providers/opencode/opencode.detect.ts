/**
 * why: opencode does not pipe its own payload to the launcher. It loads a bridge plugin this harness writes, and
 * that bridge stamps the envelope every fixture under `__test__/fixtures/` carries. Detection is therefore a
 * marker check, not a fingerprint of a vendor shape ([/decisions/ad-124.md](/decisions/ad-124.md)).
 */
const OPENCODE_MARKER = "opencode";

/**
 * invariant: the two generations are mutually exclusive on this field. Both adapters are registered, so a payload
 * matching both would make `resolveFromRegistry` report `ambiguous` and no hook would run — the generation marker
 * is what keeps that from happening.
 */
type OpencodePluginApi = "legacy" | "namespaced";

function envelope(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function detectOpencodeGeneration(raw: unknown, generation: OpencodePluginApi): boolean {
  const value = envelope(raw);
  if (value === null) {
    return false;
  }
  return value.provider === OPENCODE_MARKER && value.pluginApi === generation;
}

export function detectOpencodeLegacy(raw: unknown): boolean {
  return detectOpencodeGeneration(raw, "legacy");
}

export function detectOpencodeNamespaced(raw: unknown): boolean {
  return detectOpencodeGeneration(raw, "namespaced");
}
