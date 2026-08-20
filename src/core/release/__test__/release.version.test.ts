import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  applyBump,
  bumpFor,
  formatVersion,
  highestBump,
  INERT_SCOPES,
  parseVersion,
  planVersion,
  tagPrefixFor,
  versionInTag,
} from "../release.version.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

describe("tagPrefixFor and versionInTag", () => {
  test("a scoped name loses its scope, an unscoped one is used as it is", () => {
    assert.equal(tagPrefixFor("@tech-leads-club/harness-toolkit"), "harness-toolkit-v");
    assert.equal(tagPrefixFor("harness-toolkit"), "harness-toolkit-v");
  });

  /**
   * hazard: this is the assertion that would have caught the shipped defect. The changelog generator globbed `v*`
   * and matched none of the real tags, so every decision record read as unreleased across three releases.
   */
  test("the prefix matches the tags this repository has actually created", () => {
    const { name } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { name: string };

    assert.equal(tagPrefixFor(name), "harness-toolkit-v");
    assert.equal(versionInTag(name, "harness-toolkit-v0.2.2"), "0.2.2");
  });

  test("a tag for another package, or another scheme, is null", () => {
    const name = "@tech-leads-club/harness-toolkit";
    for (const tag of [
      "v1.0.0",
      "agent-skills-v1.4.9",
      "harness-toolkit-1.0.0",
      "harness-toolkit-vlatest",
      "",
    ]) {
      assert.equal(versionInTag(name, tag), null, tag);
    }
  });
});

describe("bumpFor", () => {
  test("feat is minor and fix is patch", () => {
    assert.equal(bumpFor({ subject: "feat: a thing" }), "minor");
    assert.equal(bumpFor({ subject: "feat(core): a thing" }), "minor");
    assert.equal(bumpFor({ subject: "fix: a thing" }), "patch");
    assert.equal(bumpFor({ subject: "fix(platform): a thing" }), "patch");
  });

  /**
   * why `perf` releases: it is a user-facing improvement, and the ecosystem default treats it as a patch. It was
   * excluded with the release loop as the reason, and the loop had nothing to do with it — the cost was a change
   * that cut the package from 1.6 MB to 426 kB sitting on `main` unreleased
   * ([/decisions/ad-098.md](/decisions/ad-098.md)).
   */
  test("AC perf earns a patch, like fix", () => {
    assert.equal(bumpFor({ subject: "perf: a thing" }), "patch");
    assert.equal(bumpFor({ subject: "perf(build): a thing" }), "patch");
  });

  /**
   * invariant: the release's own commit is `chore(release):`. If it released, every release would earn the next
   * one — which is the loop this pipeline actually ran, six versions in nine minutes. `chore` and the inert scopes
   * are what prevent it, and neither depends on `perf`.
   */
  test("everything that is not feat, fix or perf releases nothing", () => {
    for (const type of ["docs", "chore", "refactor", "test", "ci", "build", "style"]) {
      assert.equal(bumpFor({ subject: `${type}: a thing` }), "none", type);
    }
    assert.equal(bumpFor({ subject: "chore(release): 0.9.9" }), "none", "the release's own commit");
  });

  /**
   * hazard: 0.2.1, 0.2.2 and 0.2.3 were all published for CI, gate and packaging work — three immutable versions
   * that changed nothing for anyone who installed the package.
   */
  test("an inert scope releases nothing, whatever the type", () => {
    for (const scope of INERT_SCOPES) {
      assert.equal(bumpFor({ subject: `fix(${scope}): a thing` }), "none", `fix(${scope})`);
      assert.equal(bumpFor({ subject: `feat(${scope}): a thing` }), "none", `feat(${scope})`);
    }
  });

  test("an inert scope does not swallow a breaking change marker on a real scope", () => {
    assert.equal(bumpFor({ subject: "feat(platform)!: drop it" }), "major");
    assert.equal(bumpFor({ subject: "fix(ci)!: drop it" }), "none");
  });

  test("a BREAKING CHANGE footer is major even under a type that would not release", () => {
    assert.equal(bumpFor({ subject: "refactor: move it", body: "BREAKING CHANGE: the path moved" }), "major");
    assert.equal(bumpFor({ subject: "chore: x", body: "BREAKING-CHANGE: hyphenated is the same" }), "major");
  });

  test("a subject that is not conventional releases nothing rather than throwing", () => {
    assert.equal(bumpFor({ subject: "merge branch main" }), "none");
    assert.equal(bumpFor({ subject: "" }), "none");
  });
});

describe("highestBump", () => {
  test("the strongest bump in the set wins, regardless of order", () => {
    assert.equal(highestBump([{ subject: "fix: a" }, { subject: "feat: b" }]), "minor");
    assert.equal(highestBump([{ subject: "feat: b" }, { subject: "fix: a" }]), "minor");
    assert.equal(highestBump([{ subject: "docs: c" }, { subject: "feat!: d" }]), "major");
  });

  test("no commits and no releasable commits are both none", () => {
    assert.equal(highestBump([]), "none");
    assert.equal(highestBump([{ subject: "docs: c" }, { subject: "fix(ci): d" }]), "none");
  });
});

/**
 * why: below 1.0.0 a breaking change takes the minor — reaching 1.0.0 is a claim about stability a commit message
 * must not make by itself. A feature still takes the minor, and the history proves which convention is in force:
 * 0.1.0 went to 0.2.0 on a `feat:`.
 */
describe("applyBump", () => {
  test("below 1.0.0 a breaking change takes the minor, a feature also takes the minor", () => {
    const current = { major: 0, minor: 2, patch: 3 };
    assert.equal(formatVersion(applyBump(current, "major")), "0.3.0");
    assert.equal(formatVersion(applyBump(current, "minor")), "0.3.0");
    assert.equal(formatVersion(applyBump(current, "patch")), "0.2.4");
    assert.equal(formatVersion(applyBump(current, "none")), "0.2.3");
  });

  test("at or above 1.0.0 each bump moves its own field and zeroes the ones below", () => {
    const current = { major: 1, minor: 4, patch: 2 };
    assert.equal(formatVersion(applyBump(current, "major")), "2.0.0");
    assert.equal(formatVersion(applyBump(current, "minor")), "1.5.0");
    assert.equal(formatVersion(applyBump(current, "patch")), "1.4.3");
  });
});

describe("parseVersion", () => {
  test("a three-part version parses and anything else is null", () => {
    assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parseVersion(" 0.0.1 "), { major: 0, minor: 0, patch: 1 });
    for (const bad of ["1.2", "1.2.3-rc.1", "v1.2.3", "", "x"]) {
      assert.equal(parseVersion(bad), null, bad);
    }
  });
});

describe("planVersion", () => {
  /** invariant: these are the transitions this repository actually made. The calculator has to reproduce them. */
  test("reproduces the versions this repository really released", () => {
    for (const [from, subjects, want] of [
      ["0.1.0", ["feat(supply-chain): a dependency a turn adds outlives the turn"], "0.2.0"],
      ["0.2.0", ["fix(packaging): npm was dropping both executables"], "0.2.1"],
      ["0.2.2", ["fix(platform): the write lock treated a Windows code as fatal"], "0.2.3"],
    ] as [string, string[], string][]) {
      const plan = planVersion(
        from,
        subjects.map((subject) => ({ subject })),
      );
      assert.equal(plan.next, want, `${from} + ${subjects[0]}`);
    }
  });

  test("a releasable set reports the next version and what earned it", () => {
    const plan = planVersion("0.2.2", [
      { subject: "docs: notes" },
      { subject: "fix(platform): a real fix" },
      { subject: "fix(ci): plumbing" },
    ]);

    assert.equal(plan.next, "0.2.3");
    assert.equal(plan.bump, "patch");
    assert.equal(plan.released, true);
    assert.deepEqual(plan.reasons, ["fix(platform): a real fix"]);
  });

  /** invariant: `released: false` is what stops the workflow, so it is a value and never an exception. */
  test("a set of nothing but plumbing and docs releases nothing", () => {
    const plan = planVersion("0.2.3", [
      { subject: "docs(decisions): eight records become one" },
      { subject: "chore(main): release harness-toolkit 0.2.4" },
      { subject: "fix(ci): one workflow owns main" },
      { subject: "fix(release): the token keeps its repository scope" },
    ]);

    assert.equal(plan.next, "0.2.3");
    assert.equal(plan.released, false);
    assert.deepEqual(plan.reasons, []);
  });

  test("an empty commit list releases nothing", () => {
    assert.equal(planVersion("1.0.0", []).released, false);
  });

  test("a current version that cannot be parsed is an error naming the value", () => {
    assert.throws(() => planVersion("not-a-version", [{ subject: "fix: x" }]), /not-a-version/);
  });
});
