/**
 * How old a price catalogue is, and whether that is old enough to refetch.
 *
 * why: prices belong to the machine, not to a release. Shipping them in the package means a rate published today
 * reaches an operator only when they update the tool, and the catalogue in the repository was 23 days stale while
 * three versions went out ([/decisions/ad-096.md](/decisions/ad-096.md)).
 *
 * hazard: `refreshedAt` was already written into every catalogue's `_meta` by the refresh command, and read by
 * nothing. No age was reported and no refetch was ever skipped or triggered by it — a metadatum recorded and never
 * consulted, which is the same shape as the guard that read an environment variable nobody set.
 *
 * invariant: no clock of its own. `now` is a parameter, because a function that reads the wall clock cannot be
 * tested against a boundary.
 */

export const DEFAULT_TTL_DAYS = 7;

const MS_PER_DAY = 86_400_000;

export type CatalogueMeta = { refreshedAt?: string; source?: string };

export type Freshness =
  | { state: "absent" }
  | { state: "undated" }
  | { state: "fresh"; ageDays: number; refreshedAt: string }
  | { state: "stale"; ageDays: number; refreshedAt: string };

/**
 * why: `undated` is its own answer rather than "infinitely old". A catalogue written by a version that did not
 * record the date is present and usable; treating it as stale would refetch on every run, and treating it as fresh
 * would never refetch. Naming it lets the caller decide once, visibly.
 */
export function freshness(
  meta: CatalogueMeta | null,
  now: Date,
  ttlDays: number = DEFAULT_TTL_DAYS,
): Freshness {
  if (meta === null) {
    return { state: "absent" };
  }
  const stamp = meta.refreshedAt;
  if (stamp === undefined || Number.isNaN(Date.parse(stamp))) {
    return { state: "undated" };
  }
  const ageMs = now.getTime() - Date.parse(stamp);
  // invariant: a stamp from the future is age zero, not a negative age. A clock skew must not read as fresh
  // forever nor as stale immediately.
  const ageDays = Math.max(0, ageMs / MS_PER_DAY);
  return ageDays > ttlDays
    ? { state: "stale", ageDays, refreshedAt: stamp }
    : { state: "fresh", ageDays, refreshedAt: stamp };
}

/** invariant: `undated` refetches. Once, on the next run that can, after which it has a date like everything else. */
export function shouldRefetch(state: Freshness): boolean {
  return state.state === "absent" || state.state === "undated" || state.state === "stale";
}

export function freshnessMessage(state: Freshness, catalogue: string): string {
  switch (state.state) {
    case "absent":
      return `${catalogue}: not on this machine — run \`tlc harness prices refresh\``;
    case "undated":
      return `${catalogue}: present but carries no date — it will be refetched`;
    case "fresh":
      return `${catalogue}: ${describeAge(state.ageDays)} old`;
    default:
      return `${catalogue}: ${describeAge(state.ageDays)} old — run \`tlc harness prices refresh\``;
  }
}

/**
 * Whether a freshly parsed catalogue may replace the one on disk.
 *
 * hazard: the only guard was "did we parse zero entries". The upstream page grew from one table to three, the
 * parser read the first and stopped, and 43 models became 3 — which is not zero, so it passed and overwrote the
 * good catalogue. A refresh that silently loses nine tenths of its content is worse than a stale one, because the
 * staleness is at least visible in the date ([/decisions/ad-096.md](/decisions/ad-096.md)).
 *
 * invariant: growing is always allowed, and a first catalogue is always allowed. Only a large drop is refused, and
 * the refusal names both numbers so the operator can see whether upstream really shrank.
 */
export const MIN_RETAINED_RATIO = 0.5;

export type ReplaceVerdict = { replace: boolean; reason: string };

export function mayReplace(
  existingCount: number,
  incomingCount: number,
  minRatio: number = MIN_RETAINED_RATIO,
): ReplaceVerdict {
  if (incomingCount === 0) {
    return { replace: false, reason: "parsed no entries at all — the upstream format has changed" };
  }
  if (existingCount === 0) {
    return { replace: true, reason: `first catalogue, ${incomingCount} entries` };
  }
  if (incomingCount >= existingCount) {
    return { replace: true, reason: `${existingCount} → ${incomingCount} entries` };
  }
  const retained = incomingCount / existingCount;
  return retained >= minRatio
    ? { replace: true, reason: `${existingCount} → ${incomingCount} entries` }
    : {
        replace: false,
        reason: `would drop from ${existingCount} to ${incomingCount} entries, keeping the existing catalogue — the upstream format has probably changed`,
      };
}

/** why: an operator reads "3 days", not "3.4179". Hours below a day, because "0 days" reads as no information. */
export function describeAge(ageDays: number): string {
  if (ageDays < 1) {
    const hours = Math.max(1, Math.round(ageDays * 24));
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(ageDays);
  return `${days} day${days === 1 ? "" : "s"}`;
}
