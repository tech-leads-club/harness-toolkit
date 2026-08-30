import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  missingProofs,
  type Observation,
  proofLabel,
  proofSatisfied,
  unobservedKinds,
} from "../rules.proof.ts";
import type { Rule, RuleProof } from "../rules.types.ts";

const SHA = "abc1234";
const CONTEXT = { sha: SHA, sessionKey: "hostA:sess-1" };

function observed(overrides: Partial<Observation> = {}): Observation {
  return {
    kind: "subagent",
    value: "the-jury",
    sha: SHA,
    sessionKey: "hostA:sess-1",
    at: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

function rule(require: RuleProof[]): Rule {
  return {
    name: "r",
    tier: "project",
    enabled: true,
    on: { kind: "pr-open" },
    require,
    otherwise: "deny",
    body: "b",
  };
}

describe("proofSatisfied", () => {
  test("AC5 a subagent proof is satisfied by that subagent having run", () => {
    const proof: RuleProof = { kind: "subagent", value: "the-jury", since: "head" };

    assert.equal(proofSatisfied(proof, [observed()], CONTEXT), true);
    assert.equal(proofSatisfied(proof, [observed({ value: "explore" })], CONTEXT), false);
    assert.equal(proofSatisfied(proof, [], CONTEXT), false);
  });

  /**
   * AC4 — freshness is part of the proof. A review of the code as it was two commits ago reviewed something else.
   */
  test("AC4 proof recorded against another HEAD does not satisfy `since HEAD`", () => {
    const proof: RuleProof = { kind: "subagent", value: "the-jury", since: "head" };

    assert.equal(proofSatisfied(proof, [observed({ sha: "0000000" })], CONTEXT), false);
  });

  test("AC4 `since session` accepts an older sha but only this session", () => {
    const proof: RuleProof = { kind: "subagent", value: "the-jury", since: "session" };

    assert.equal(proofSatisfied(proof, [observed({ sha: "0000000" })], CONTEXT), true);
    assert.equal(
      proofSatisfied(proof, [observed({ sessionKey: "hostA:other" })], CONTEXT),
      false,
      "another session's work is not this session's proof",
    );
  });

  /**
   * hazard: with no git checkout there is no HEAD to compare. Treating "no sha" as "any sha" would make every
   * `since HEAD` rule satisfiable by anything ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  test("AC4 a project with no sha cannot satisfy `since HEAD`", () => {
    const proof: RuleProof = { kind: "subagent", value: "the-jury", since: "head" };

    assert.equal(
      proofSatisfied(proof, [observed({ sha: null })], { sha: null, sessionKey: "hostA:sess-1" }),
      false,
    );
  });

  test("AC5 a command proof matches the operator's phrase in the observed command", () => {
    const proof: RuleProof = { kind: "command", value: "gh pr review", since: "head" };

    assert.equal(
      proofSatisfied(proof, [observed({ kind: "command", value: "gh pr review 42 --approve" })], CONTEXT),
      true,
    );
    assert.equal(proofSatisfied(proof, [observed({ kind: "command", value: "gh pr list" })], CONTEXT), false);
  });

  test("AC5 a gate proof matches the gate's name", () => {
    const proof: RuleProof = { kind: "gate", value: "test", since: "head" };

    assert.equal(proofSatisfied(proof, [observed({ kind: "gate", value: "test" })], CONTEXT), true);
    assert.equal(proofSatisfied(proof, [observed({ kind: "gate", value: "lint" })], CONTEXT), false);
  });

  /** why three shapes and no glob engine: nothing else here needs globs, and each shape is stated. */
  test("AC5 a file proof matches an exact path, a *.ext suffix, or a dir/ prefix", () => {
    const exact: RuleProof = { kind: "file", value: "docs/review.md", since: "head" };
    const suffix: RuleProof = { kind: "file", value: "*.md", since: "head" };
    const dir: RuleProof = { kind: "file", value: "docs/", since: "head" };

    assert.equal(proofSatisfied(exact, [observed({ kind: "file", value: "docs/review.md" })], CONTEXT), true);
    assert.equal(proofSatisfied(suffix, [observed({ kind: "file", value: "notes/x.md" })], CONTEXT), true);
    assert.equal(proofSatisfied(suffix, [observed({ kind: "file", value: "notes/x.ts" })], CONTEXT), false);
    assert.equal(proofSatisfied(dir, [observed({ kind: "file", value: "docs/deep/x.md" })], CONTEXT), true);
    assert.equal(proofSatisfied(dir, [observed({ kind: "file", value: "src/x.md" })], CONTEXT), false);
  });

  /** invariant: kinds never cross. A command that mentions a subagent's name is not a subagent having run. */
  test("AC5 an observation of another kind never satisfies a proof", () => {
    const proof: RuleProof = { kind: "subagent", value: "the-jury", since: "head" };

    assert.equal(proofSatisfied(proof, [observed({ kind: "command", value: "the-jury" })], CONTEXT), false);
  });
});

describe("missingProofs", () => {
  test("every proof must hold — the list is a conjunction", () => {
    const target = rule([
      { kind: "subagent", value: "the-jury", since: "head" },
      { kind: "gate", value: "test", since: "head" },
    ]);

    const missing = missingProofs(target, [observed()], CONTEXT);

    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.proof.kind, "gate");
  });

  test("nothing missing when all proofs hold", () => {
    const target = rule([
      { kind: "subagent", value: "the-jury", since: "head" },
      { kind: "gate", value: "test", since: "head" },
    ]);

    const missing = missingProofs(target, [observed(), observed({ kind: "gate", value: "test" })], CONTEXT);

    assert.deepEqual(missing, []);
  });

  test("the label an operator reads names the kind, the value and the window", () => {
    assert.equal(
      proofLabel({ proof: { kind: "subagent", value: "the-jury", since: "head" }, reason: null }),
      "subagent(the-jury) since HEAD",
    );
    assert.equal(
      proofLabel({ proof: { kind: "gate", value: "test", since: "session" }, reason: null }),
      "gate(test) since session",
    );
  });

  /**
   * AC — the label distinguishes "never observed" from "observed, but the window rejected it," across every
   * proof kind and both windows. A fact the harness already holds, not a new read.
   */
  test("a proof that ran under the wrong window says so, by kind", () => {
    const cases: Array<{ proof: RuleProof; observation: Partial<Observation> }> = [
      { proof: { kind: "subagent", value: "the-jury", since: "head" }, observation: { sha: "0000000" } },
      {
        proof: { kind: "command", value: "gh pr review", since: "head" },
        observation: { kind: "command", value: "gh pr review 42", sha: "0000000" },
      },
      {
        proof: { kind: "gate", value: "test", since: "head" },
        observation: { kind: "gate", value: "test", sha: "0000000" },
      },
      {
        proof: { kind: "file", value: "docs/review.md", since: "head" },
        observation: { kind: "file", value: "docs/review.md", sha: "0000000" },
      },
    ];

    for (const { proof, observation } of cases) {
      const target = rule([proof]);
      const missing = missingProofs(target, [observed(observation)], CONTEXT);

      assert.equal(missing.length, 1, proof.kind);
      assert.equal(missing[0]?.reason, "ran, but at a different commit", proof.kind);
      assert.match(proofLabel(missing[0] as never), /\(ran, but at a different commit\)$/, proof.kind);
    }
  });

  test("since session says a different session, not a different commit", () => {
    const proof: RuleProof = { kind: "subagent", value: "the-jury", since: "session" };
    const target = rule([proof]);

    const missing = missingProofs(target, [observed({ sessionKey: "hostA:other" })], CONTEXT);

    assert.equal(missing[0]?.reason, "ran, but in a different session");
  });

  test("no git checkout says so, not a different commit", () => {
    const proof: RuleProof = { kind: "subagent", value: "the-jury", since: "head" };
    const target = rule([proof]);
    const context = { sha: null, sessionKey: "hostA:sess-1" };

    const missing = missingProofs(target, [observed({ sha: null })], context);

    assert.equal(
      missing[0]?.reason,
      "ran, but this project is not a git checkout, so since HEAD can never be satisfied",
    );
  });

  test("truly never observed stays a flat, honest missing — no invented reason", () => {
    const target = rule([{ kind: "subagent", value: "the-jury", since: "head" }]);

    const missing = missingProofs(target, [], CONTEXT);

    assert.equal(missing[0]?.reason, null);
    assert.equal(proofLabel(missing[0] as never), "subagent(the-jury) since HEAD");
  });

  test("a value mismatch (wrong subagent/command/gate/file) is never mistaken for staleness", () => {
    const target = rule([{ kind: "subagent", value: "the-jury", since: "head" }]);

    const missing = missingProofs(target, [observed({ value: "explore" })], CONTEXT);

    assert.equal(
      missing[0]?.reason,
      null,
      'a different value never satisfied the kind, so it is not "stale"',
    );
  });
});

/**
 * AC11 — what `doctor` needs to say a rule can never be satisfied here. Factual, not a guess about the host: a
 * kind of observation this project has never recorded ([/decisions/ad-034.md](/decisions/ad-034.md)).
 */
describe("unobservedKinds", () => {
  test("AC11 a rule requiring a kind never recorded here is named, with the kind", () => {
    const target = rule([{ kind: "subagent", value: "the-jury", since: "head" }]);

    assert.deepEqual(unobservedKinds([target], []), [{ rule: "r", kinds: ["subagent"] }]);
    assert.deepEqual(unobservedKinds([target], [observed()]), []);
  });

  test("AC11 only the kinds that were never seen are reported", () => {
    const target = rule([
      { kind: "subagent", value: "the-jury", since: "head" },
      { kind: "gate", value: "test", since: "head" },
    ]);

    assert.deepEqual(unobservedKinds([target], [observed()]), [{ rule: "r", kinds: ["gate"] }]);
  });
});
