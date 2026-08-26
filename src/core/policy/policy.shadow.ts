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

/** A leaf the project config names that `resolved` (the shipped `Policy` shape) has no counterpart for. */
export type UnknownKey = { path: string; value: unknown };

/** A leaf present in both, whose runtime shape disagrees with the default's. */
export type TypeMismatch = { path: string; expected: string; actual: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * why: `typeof null` is `"object"`, indistinguishable from a real object without this. A field whose
 * default is `null` (`evidenceDir`, `lintCommand`, `minEffort`, ...) is a `T | null` union in `Policy`
 * — comparing `typeof` directly against that default would flag every valid non-null override as a
 * mismatch, which is why the mismatch check below exempts `below === null` entirely.
 */
function typeLabel(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (isPlainObject(value)) {
    return "object";
  }
  return typeof value;
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
type WalkResult = {
  shadowed: ShadowedKey[];
  kept: Record<string, unknown>;
  unknown: UnknownKey[];
  mismatched: TypeMismatch[];
};

function walk(
  project: Record<string, unknown>,
  resolved: Record<string, unknown>,
  prefix: string,
): WalkResult {
  const shadowed: ShadowedKey[] = [];
  const kept: Record<string, unknown> = {};
  const unknown: UnknownKey[] = [];
  const mismatched: TypeMismatch[] = [];
  for (const [key, value] of Object.entries(project)) {
    // why kept and never reported: `version` marks the config's shape rather than a setting, so naming it is
    // required rather than redundant.
    if (prefix === "" && key === "version") {
      kept[key] = value;
      continue;
    }
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const below = resolved[key];
    // why not merged into the branches below: a key absent from `resolved` still needs its value judged for
    // `shadowed`/`kept` exactly as before — this only ever adds to `unknown`, never changes the other three.
    if (!(key in resolved)) {
      unknown.push({ path, value });
    }
    if (isPlainObject(value) && isPlainObject(below)) {
      const inner = walk(value, below, path);
      shadowed.push(...inner.shadowed);
      unknown.push(...inner.unknown);
      mismatched.push(...inner.mismatched);
      // why empty blocks go: `{ shipGate: {} }` decides nothing, and leaving it behind would make a pruned config
      // read as though it had opinions.
      if (Object.keys(inner.kept).length > 0) {
        kept[key] = inner.kept;
      }
      continue;
    }
    // why `below === null` is exempt: see `typeLabel`'s doc — a `T | null` default cannot be told apart
    // from a real type mismatch by `typeof` alone, and a false positive here is worse than a miss.
    if (below !== null && below !== undefined && typeLabel(value) !== typeLabel(below)) {
      mismatched.push({ path, expected: typeLabel(below), actual: typeLabel(value) });
    }
    if (sameValue(value, below)) {
      shadowed.push({ path, value });
    } else {
      kept[key] = value;
    }
  }
  return { shadowed, kept, unknown, mismatched };
}

/** What `doctor` reports: every leaf whose value the tiers below already resolve to. */
export function shadowedKeys(
  project: Record<string, unknown>,
  resolved: Record<string, unknown>,
): ShadowedKey[] {
  return walk(project, resolved, "").shadowed;
}

/**
 * What `doctor` reports: every leaf `resolved` (the shipped `Policy` shape) has no counterpart for —
 * the `format` bug's exact shape, a key that does nothing because nothing reads it.
 */
export function unknownKeys(
  project: Record<string, unknown>,
  resolved: Record<string, unknown>,
): UnknownKey[] {
  return walk(project, resolved, "").unknown;
}

/** What `doctor` reports: every leaf present in both, whose runtime shape disagrees with the default's. */
export function typeMismatches(
  project: Record<string, unknown>,
  resolved: Record<string, unknown>,
): TypeMismatch[] {
  return walk(project, resolved, "").mismatched;
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
