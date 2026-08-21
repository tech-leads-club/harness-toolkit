import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promotionProblems, tagFor } from "../dev/verify-promotable.mjs";

/**
 * hazard: these three checks were inline shell in the workflow, so a test could only assert the strings were
 * present. A probe that wrapped one in `false &&` left the assertion green — a substring cannot see logic being
 * neutered. Executed against inputs instead ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
const ALL_GOOD = {
  publishedOnNpm: () => true,
  gitTagExists: () => true,
  releaseExists: () => true,
};

describe("promotionProblems", () => {
  test("a finished release has nothing to report", () => {
    assert.deepEqual(promotionProblems("pkg", "1.2.3", ALL_GOOD), []);
  });

  test("a version npm does not have is refused by name", () => {
    const problems = promotionProblems("pkg", "1.2.3", { ...ALL_GOOD, publishedOnNpm: () => false });

    assert.equal(problems.length, 1);
    assert.match(problems[0] as string, /npm has no pkg@1\.2\.3/);
  });

  /** invariant: a published version with no tag means the run stopped in the window that needs a human. */
  test("a missing git tag is refused, naming the tag", () => {
    const problems = promotionProblems("pkg", "1.2.3", { ...ALL_GOOD, gitTagExists: () => false });

    assert.deepEqual(problems, ["no git tag harness-toolkit-v1.2.3 — that release did not finish"]);
  });

  test("a missing GitHub release is refused too", () => {
    const problems = promotionProblems("pkg", "1.2.3", { ...ALL_GOOD, releaseExists: () => false });

    assert.match(problems[0] as string, /no GitHub release for harness-toolkit-v1\.2\.3/);
  });

  /** invariant: every failing claim, not the first — an operator fixing one at a time is the loop this avoids. */
  test("all three are reported together", () => {
    const problems = promotionProblems("pkg", "1.2.3", {
      publishedOnNpm: () => false,
      gitTagExists: () => false,
      releaseExists: () => false,
    });

    assert.equal(problems.length, 3);
  });

  test("the tag is derived from the version, not passed in", () => {
    assert.equal(tagFor("0.4.3"), "harness-toolkit-v0.4.3");
  });
});
