import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_TTL_DAYS,
  describeAge,
  freshness,
  freshnessMessage,
  mayReplace,
  shouldRefetch,
} from "../pricing.freshness.ts";

const NOW = new Date("2026-08-19T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe("freshness", () => {
  test("no catalogue at all is absent", () => {
    assert.deepEqual(freshness(null, NOW), { state: "absent" });
  });

  /**
   * why: a catalogue written before this existed has no date. Treating it as stale refetches on every run;
   * treating it as fresh never refetches. It is its own answer so the caller decides once.
   */
  test("a catalogue with no usable date is undated, not infinitely old", () => {
    assert.equal(freshness({}, NOW).state, "undated");
    assert.equal(freshness({ refreshedAt: "not a date" }, NOW).state, "undated");
  });

  test("inside the TTL it is fresh, outside it is stale", () => {
    assert.equal(freshness({ refreshedAt: daysAgo(1) }, NOW).state, "fresh");
    assert.equal(freshness({ refreshedAt: daysAgo(DEFAULT_TTL_DAYS - 0.5) }, NOW).state, "fresh");
    assert.equal(freshness({ refreshedAt: daysAgo(DEFAULT_TTL_DAYS + 0.5) }, NOW).state, "stale");
  });

  /** invariant: exactly at the TTL is still fresh — the boundary belongs to the side that does not fetch. */
  test("exactly at the TTL is fresh", () => {
    assert.equal(freshness({ refreshedAt: daysAgo(DEFAULT_TTL_DAYS) }, NOW).state, "fresh");
  });

  test("the TTL is a parameter, so a caller can be strict or lax", () => {
    const stamp = { refreshedAt: daysAgo(3) };
    assert.equal(freshness(stamp, NOW, 1).state, "stale");
    assert.equal(freshness(stamp, NOW, 30).state, "fresh");
  });

  /** hazard: a clock skew must not read as fresh for ever, nor as stale immediately. */
  test("a stamp from the future is age zero rather than a negative age", () => {
    const state = freshness({ refreshedAt: daysAgo(-5) }, NOW);

    assert.equal(state.state, "fresh");
    assert.equal(state.state === "fresh" ? state.ageDays : -1, 0);
  });

  /**
   * hazard: this is the real catalogue this repository shipped — written 2026-07-27 and still in the package on
   * 2026-08-19, through three published versions.
   */
  test("the catalogue this repository actually shipped reads as stale", () => {
    const state = freshness({ refreshedAt: "2026-07-27T14:51:17.065Z" }, NOW);

    assert.equal(state.state, "stale");
    assert.equal(state.state === "stale" ? Math.round(state.ageDays) : 0, 23);
  });
});

describe("shouldRefetch", () => {
  test("absent, undated and stale all refetch; fresh does not", () => {
    assert.equal(shouldRefetch({ state: "absent" }), true);
    assert.equal(shouldRefetch({ state: "undated" }), true);
    assert.equal(shouldRefetch({ state: "stale", ageDays: 9, refreshedAt: daysAgo(9) }), true);
    assert.equal(shouldRefetch({ state: "fresh", ageDays: 1, refreshedAt: daysAgo(1) }), false);
  });
});

describe("freshnessMessage", () => {
  test("absent and stale name the command; fresh does not", () => {
    assert.match(freshnessMessage({ state: "absent" }, "prices"), /prices refresh/);
    assert.match(
      freshnessMessage({ state: "stale", ageDays: 9, refreshedAt: daysAgo(9) }, "prices"),
      /prices refresh/,
    );
    assert.doesNotMatch(
      freshnessMessage({ state: "fresh", ageDays: 1, refreshedAt: daysAgo(1) }, "prices"),
      /refresh/,
    );
  });

  /** why: a fixed remediation on a passing line reads as an instruction the operator has to act on. */
  test("every state names the catalogue it is about", () => {
    for (const state of [
      { state: "absent" as const },
      { state: "undated" as const },
      { state: "fresh" as const, ageDays: 1, refreshedAt: daysAgo(1) },
      { state: "stale" as const, ageDays: 9, refreshedAt: daysAgo(9) },
    ]) {
      assert.match(freshnessMessage(state, "the-catalogue"), /the-catalogue/);
    }
  });
});

describe("mayReplace", () => {
  /**
   * hazard: this is what actually happened. The upstream page grew from one table to three, the parser read the
   * first and stopped, 43 models became 3 — and the only guard was `count === 0`, so the mutilated catalogue
   * overwrote the good one and printed a success line.
   */
  test("AC the drop that shipped today is refused, and says both numbers", () => {
    const verdict = mayReplace(43, 3);

    assert.equal(verdict.replace, false);
    assert.match(verdict.reason, /43/);
    assert.match(verdict.reason, /3/);
    assert.match(verdict.reason, /format has probably changed/);
  });

  test("AC growing is allowed, which is what the corrected parser does", () => {
    assert.equal(mayReplace(43, 44).replace, true);
  });

  /** invariant: a first catalogue has nothing to lose, so any non-empty parse is an improvement. */
  test("AC a first catalogue is always accepted", () => {
    assert.equal(mayReplace(0, 44).replace, true);
    assert.equal(mayReplace(0, 1).replace, true);
  });

  test("AC an empty parse is refused whatever is on disk", () => {
    assert.equal(mayReplace(43, 0).replace, false);
    assert.equal(mayReplace(0, 0).replace, false);
  });

  /** why: upstream genuinely removing a few models must not block the refresh for ever. */
  test("a modest shrink is accepted", () => {
    assert.equal(mayReplace(44, 40).replace, true);
    assert.equal(mayReplace(44, 22).replace, true, "exactly at the ratio");
    assert.equal(mayReplace(44, 21).replace, false, "just below it");
  });

  test("the ratio is a parameter, so a caller can be strict", () => {
    assert.equal(mayReplace(100, 90, 0.95).replace, false);
    assert.equal(mayReplace(100, 90, 0.5).replace, true);
  });
});

describe("describeAge", () => {
  test("hours below a day, days above, and never a bare zero", () => {
    assert.equal(describeAge(0), "1 hour");
    assert.equal(describeAge(1 / 24), "1 hour");
    assert.equal(describeAge(5 / 24), "5 hours");
    assert.equal(describeAge(1), "1 day");
    assert.equal(describeAge(23.4), "23 days");
  });
});
