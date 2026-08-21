/**
 * Which keys a project config restates rather than decides.
 *
 * why this is worth reporting: the layers are `DEFAULTS < user < project`, so a project key naming the value the
 * lower tiers already resolve to changes nothing today and shadows them for ever. The moment the operator edits
 * the machine-wide config, every project that restated the old value keeps it — and nothing said so. `init` writes
 * the whole default policy when there is no config yet, and the wizard writes every knob it collected, so this is
 * the common case rather than the odd one ([/decisions/ad-100.md](/decisions/ad-100.md)).
 *
 * invariant: pure, and it reports rather than decides. A key that restates a default is not a fault — it is a key
 * that has stopped tracking the tier below it, which is a thing an operator may want and must be able to see.
 */
/** A leaf the project config names, and the value it would have had without naming it. */
export type ShadowedKey = { path: string; value: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * why a JSON comparison rather than a deep walk of its own: the values are config leaves — scalars and small
 * arrays — and `codePaths: ["src"]` has to compare equal to `codePaths: ["src"]`. A second structural comparator
 * here would be the copy that disagrees with the merge later.
 */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every leaf in `project` whose value the lower tiers already resolve to.
 *
 * `resolved` is the policy as it would be with the project config absent — `DEFAULTS` merged with the user tier.
 */
export function shadowedKeys(
  project: Record<string, unknown>,
  resolved: Record<string, unknown>,
  prefix = "",
): ShadowedKey[] {
  const found: ShadowedKey[] = [];
  for (const [key, value] of Object.entries(project)) {
    // why skipped: `version` is the config's own shape marker rather than a setting, so naming it is required
    // rather than redundant.
    if (prefix === "" && key === "version") {
      continue;
    }
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const below = resolved[key];
    if (isPlainObject(value) && isPlainObject(below)) {
      found.push(...shadowedKeys(value, below, path));
      continue;
    }
    if (sameValue(value, below)) {
      found.push({ path, value });
    }
  }
  return found;
}

/**
 * The project config with every restatement removed.
 *
 * why this and not just a report: `init` wrote the whole default policy when a project had no config yet, and the
 * wizard wrote every knob it collected — so a fresh project shadowed the machine tier in dozens of places before
 * anyone had chosen anything. Reporting it after the fact leaves the operator to undo it by hand; not writing it
 * is the fix ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * invariant: pruning cannot change the effective policy. A leaf is dropped only when the tiers below already
 * resolve to it, so the merge produces the same value with the key absent.
 *
 * why empty objects go too: `{ shipGate: {} }` is a block that decides nothing, and leaving it behind would make
 * a pruned config read as though it had opinions.
 */
export function pruneShadowed(
  project: Record<string, unknown>,
  resolved: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(project)) {
    if (prefix === "" && key === "version") {
      kept[key] = value;
      continue;
    }
    const below = resolved[key];
    if (isPlainObject(value) && isPlainObject(below)) {
      const inner = pruneShadowed(value, below, `${prefix}${key}.`);
      if (Object.keys(inner).length > 0) {
        kept[key] = inner;
      }
      continue;
    }
    if (!sameValue(value, below)) {
      kept[key] = value;
    }
  }
  return kept;
}
