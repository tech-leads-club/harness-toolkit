import { type CapabilityCatalog, type CatalogCapability, ENABLE_HINT } from "./capability.types.ts";

/**
 * why `object` and not `Record<string, unknown>`: the callers hand this the *effective* policy, which is a typed
 * `Policy` rather than a bag of unknowns. Narrowing the parameter forced a cast at every call site, and a cast is
 * where a wrong argument stops being a type error ([/decisions/ad-103.md](/decisions/ad-103.md)).
 */
export function resolveConfigPath(policy: object, configPath: string): unknown {
  let current: unknown = policy;
  for (const part of configPath.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function isAvailableNotEnabled(policy: object, cap: CatalogCapability): boolean {
  const value = resolveConfigPath(policy, cap.configPath);
  return cap.defaultOn ? value === false : value !== true;
}

/**
 * hazard: this used to be handed the project's config file alone, so a capability switched on in the machine tier
 * was reported as "available and not enabled" while it was being enforced — and `doctor`'s neighbouring row tells
 * the operator to delete restatements, which is what produces exactly that state. A row that says a rail is off
 * while the rail is on is worse than no row ([/decisions/ad-103.md](/decisions/ad-103.md)).
 */
export function listAvailableNotEnabled(policy: object, catalog: CapabilityCatalog): CatalogCapability[] {
  return catalog.capabilities.filter((cap) => isAvailableNotEnabled(policy, cap));
}

export function listNewlyAnnounceable(
  policy: object,
  catalog: CapabilityCatalog,
  seenCatalogVersion: number,
): CatalogCapability[] {
  return listAvailableNotEnabled(policy, catalog).filter(
    (cap) => cap.sinceCatalogVersion > seenCatalogVersion,
  );
}

export function formatCapabilityDigest(caps: CatalogCapability[]): string {
  const lines = ["Available for this project (not enabled yet):", ""];
  for (const cap of caps) {
    lines.push(`• ${cap.title}`);
    lines.push(`  Benefit:  ${cap.benefit}`);
    lines.push(`  Trade-off: ${cap.tradeOff}`);
    lines.push("");
  }
  lines.push(ENABLE_HINT);
  return lines.join("\n").trimEnd();
}

// hazard: this prefixed "WARN:" while the row it lands in already carries its level, so an operator read the word
// twice. Seen in a real doctor run ([/decisions/ad-034.md](/decisions/ad-034.md)).
export function formatDoctorWarn(cap: CatalogCapability): string {
  return `${cap.title} off — ${cap.tradeOff} — ${ENABLE_HINT}`;
}

/**
 * hazard: every capability that was merely *not enabled* produced a warning, so a healthy install printed nine of
 * them and the two rows that needed attention were buried in the middle. An optional capability nobody switched on is
 * inventory, not a fault, and a warning that fires on a healthy install teaches the reader to skip warnings — which
 * is how the row that mattered got missed ([/decisions/ad-034.md](/decisions/ad-034.md)).
 */
export function formatAvailableInventory(caps: readonly CatalogCapability[]): string {
  return `${caps.length} available and not enabled: ${caps.map((cap) => cap.id).join(", ")}. ${ENABLE_HINT}`;
}
