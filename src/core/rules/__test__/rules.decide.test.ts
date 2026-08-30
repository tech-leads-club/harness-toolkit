import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actionDecision, effectiveVerdict, evaluateRules, ruleMessage, strictest } from "../rules.decide.ts";
import type { Observation } from "../rules.proof.ts";
import type { Rule, RuleVerdict } from "../rules.types.ts";

const CONTEXT = { sha: "abc1234", sessionKey: "hostA:sess-1", mode: "solo" as const };

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    name: "review-before-pr",
    tier: "global",
    enabled: true,
    on: { kind: "pr-open" },
    require: [{ kind: "subagent", value: "the-jury", since: "head" }],
    otherwise: "deny",
    body: "Convene the jury.\nChecklist: docs/review-checklist.md",
    ...overrides,
  };
}

const PROOF: Observation = {
  kind: "subagent",
  value: "the-jury",
  sha: "abc1234",
  sessionKey: "hostA:sess-1",
  at: "2026-08-21T10:00:00.000Z",
};

/**
 * AC13 — posture governs interruption and nothing else. `deny`, `follow-up` and `warn` are verification, and a
 * posture that changed them would be clearing a check ([/decisions/ad-025.md](/decisions/ad-025.md) item 4).
 */
describe("effectiveVerdict", () => {
  test("AC13 ask interrupts under paired and hardens to deny under solo and focus", () => {
    assert.equal(effectiveVerdict("ask", "paired"), "ask");
    assert.equal(effectiveVerdict("ask", "solo"), "deny");
    assert.equal(effectiveVerdict("ask", "focus"), "deny");
  });

  test("AC13 the other three verdicts are identical at every posture", () => {
    for (const mode of ["paired", "solo", "focus"] as const) {
      for (const declared of ["deny", "follow-up", "warn"] as RuleVerdict[]) {
        assert.equal(effectiveVerdict(declared, mode), declared, `${declared} under ${mode}`);
      }
    }
  });

  /** invariant: it hardens, never softens. Softening would let a posture clear a verification. */
  test("AC13 no posture ever turns a verdict into something weaker", () => {
    const order: RuleVerdict[] = ["warn", "follow-up", "ask", "deny"];
    for (const mode of ["paired", "solo", "focus"] as const) {
      for (const declared of order) {
        assert.ok(
          order.indexOf(effectiveVerdict(declared, mode)) >= order.indexOf(declared),
          `${declared} weakened under ${mode}`,
        );
      }
    }
  });
});

describe("evaluateRules", () => {
  /** invariant: silence on the healthy path ([/decisions/ad-034.md](/decisions/ad-034.md)). */
  test("AC3 a rule whose proof holds produces nothing", () => {
    assert.deepEqual(evaluateRules([rule()], [PROOF], CONTEXT), []);
  });

  test("AC2 a rule whose proof is missing produces its verdict and names what is missing", () => {
    const [outcome] = evaluateRules([rule()], [], CONTEXT);

    assert.equal(outcome?.verdict, "deny");
    assert.deepEqual(outcome?.missing, ["subagent(the-jury) since HEAD"]);
  });

  /** AC4 — proof against another sha is not proof, and the message says it ran, just not here. */
  test("AC4 stale proof leaves the rule unsatisfied, and says so", () => {
    const [outcome] = evaluateRules([rule()], [{ ...PROOF, sha: "0000000" }], CONTEXT);

    assert.equal(outcome?.verdict, "deny");
    assert.deepEqual(outcome?.missing, ["subagent(the-jury) since HEAD (ran, but at a different commit)"]);
  });

  test("AC13 the declared ask becomes deny under solo, and stays ask under paired", () => {
    const asking = [rule({ otherwise: "ask" })];

    assert.equal(evaluateRules(asking, [], CONTEXT)[0]?.verdict, "deny");
    assert.equal(evaluateRules(asking, [], { ...CONTEXT, mode: "paired" })[0]?.verdict, "ask");
  });
});

/** AC6/D6 — the body is the operator's text, and the harness adds only the rule and what is missing. */
describe("ruleMessage", () => {
  test("the operator's body survives verbatim, under the rule's name and the gap", () => {
    const message = ruleMessage(rule(), ["subagent(the-jury) since HEAD"]);

    assert.match(message, /^rule review-before-pr \(global\): missing subagent\(the-jury\) since HEAD/);
    assert.match(message, /Convene the jury\./);
    assert.match(message, /docs\/review-checklist\.md/);
  });

  test("a rule with no body still says which rule and what is missing", () => {
    assert.equal(
      ruleMessage(rule({ body: "" }), ["gate(test) since HEAD"]),
      "rule review-before-pr (global): missing gate(test) since HEAD",
    );
  });
});

/** invariant: the strictest outcome decides, as every host resolves two hooks answering one event. */
describe("strictest", () => {
  test("deny beats ask beats follow-up beats warn", () => {
    const outcomes = evaluateRules(
      [
        rule({ name: "a", otherwise: "warn" }),
        rule({ name: "b", otherwise: "follow-up" }),
        rule({ name: "c", otherwise: "deny" }),
      ],
      [],
      CONTEXT,
    );

    assert.equal(strictest(outcomes)?.rule.name, "c");
  });

  test("nothing to decide is null, not a permissive default", () => {
    assert.equal(strictest([]), null);
  });
});

describe("actionDecision", () => {
  test("AC2 deny refuses the action with the rule's message and its own rule name", () => {
    const [outcome] = evaluateRules([rule()], [], CONTEXT);
    const decision = actionDecision(outcome as never);

    assert.equal(decision.kind, "deny");
    assert.equal(decision.rule, "rule:review-before-pr");
    assert.match(decision.kind === "deny" ? decision.reason : "", /Convene the jury/);
  });

  test("AC7/AC8 follow-up and warn never block the action", () => {
    for (const otherwise of ["follow-up", "warn"] as RuleVerdict[]) {
      const [outcome] = evaluateRules([rule({ otherwise })], [], CONTEXT);
      assert.equal(actionDecision(outcome as never).kind, "abstain", otherwise);
    }
  });

  test("ask under paired reaches the operator with the same text in both fields", () => {
    const [outcome] = evaluateRules([rule({ otherwise: "ask" })], [], { ...CONTEXT, mode: "paired" });
    const decision = actionDecision(outcome as never);

    assert.equal(decision.kind, "ask");
    if (decision.kind === "ask") {
      assert.match(decision.reason, /Convene the jury/);
      assert.match(String(decision.userNote), /Convene the jury/);
    }
  });
});
