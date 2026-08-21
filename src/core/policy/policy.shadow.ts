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
 * One walk, two questions.
 *
 * hazard: `shadowedKeys` and `pruneShadowed` were two recursions over the same tree applying the same leaf test —
 * so a change to what counts as a restatement had to be made twice, and the report and the pruner could disagree
 * about the same config ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * `resolved` is the policy as it would be with the project config absent: the shipped defaults merged with this
 * machine's tier.
 */
function walk(
  project: Record<string, unknown>,
  resolved: Record<string, unknown>,
  prefix: string,
): { shadowed: ShadowedKey[]; kept: Record<string, unknown> } {
  const shadowed: ShadowedKey[] = [];
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(project)) {
    // why kept and never reported: `version` marks the config's shape rather than a setting, so naming it is
    // required rather than redundant.
    if (prefix === "" && key === "version") {
      kept[key] = value;
      continue;
    }
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const below = resolved[key];
    if (isPlainObject(value) && isPlainObject(below)) {
      const inner = walk(value, below, path);
      shadowed.push(...inner.shadowed);
      // why empty blocks go: `{ shipGate: {} }` decides nothing, and leaving it behind would make a pruned config
      // read as though it had opinions.
      if (Object.keys(inner.kept).length > 0) {
        kept[key] = inner.kept;
      }
      continue;
    }
    if (sameValue(value, below)) {
      shadowed.push({ path, value });
    } else {
      kept[key] = value;
    }
  }
  return { shadowed, kept };
}

/** What `doctor` reports: every leaf whose value the tiers below already resolve to. */
export function shadowedKeys(
  project: Record<string, unknown>,
  resolved: Record<string, unknown>,
): ShadowedKey[] {
  return walk(project, resolved, "").shadowed;
}

/**
 * What `init` writes: the same config with every restatement removed.
 *
 * invariant: pruning cannot change the effective policy. A leaf is dropped only when the tiers below already
 * resolve to it, so the merge produces the same value with the key absent.
 */
export function pruneShadowed(
  project: Record<string, unknown>,
  resolved: Record<string, unknown>,
): Record<string, unknown> {
  return walk(project, resolved, "").kept;
}
