import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildRuleSet, parseRule, type RuleSource } from "../rules.parse.ts";

function source(text: string, overrides: Partial<RuleSource> = {}): RuleSource {
  return { name: "review-before-pr", tier: "project", text, ...overrides };
}

const COMPLETE = `---
on: pr-open
require:
  - subagent(the-jury) since HEAD
  - command(gh pr review) since session
otherwise: deny
---

Convene the jury on the open pull request.
Checklist: docs/review-checklist.md`;

describe("parseRule", () => {
  test("AC2 a complete rule yields its trigger, its proofs, its verdict and its body", () => {
    const parsed = parseRule(source(COMPLETE));

    assert.ok("rule" in parsed, JSON.stringify(parsed));
    const rule = parsed.rule;
    assert.deepEqual(rule.on, { kind: "pr-open" });
    assert.equal(rule.otherwise, "deny");
    assert.deepEqual(rule.require, [
      { kind: "subagent", value: "the-jury", since: "head" },
      { kind: "command", value: "gh pr review", since: "session" },
    ]);
    assert.match(rule.body, /Convene the jury/);
    assert.match(rule.body, /review-checklist/, "the operator's own attachment survives verbatim");
    assert.equal(rule.enabled, true);
  });

  /** invariant: HEAD is the default window, because a review of two commits ago reviewed something else. */
  test("a proof with no window is evaluated against HEAD", () => {
    const parsed = parseRule(
      source(`---\non: stop\nrequire:\n  - gate(test)\notherwise: follow-up\n---\nbody`),
    );

    assert.ok("rule" in parsed);
    assert.deepEqual(parsed.rule.require, [{ kind: "gate", value: "test", since: "head" }]);
  });

  test("each trigger in the vocabulary parses, and one outside it is an error", () => {
    for (const on of ["pr-open", "commit", "push", "stop"]) {
      const parsed = parseRule(source(`---\non: ${on}\nrequire:\n  - gate(test)\notherwise: warn\n---\nb`));
      assert.ok("rule" in parsed, on);
    }
    const tool = parseRule(source(`---\non: tool(Write)\nrequire:\n  - gate(test)\notherwise: warn\n---\nb`));
    assert.deepEqual("rule" in tool ? tool.rule.on : null, { kind: "tool", name: "Write" });

    const command = parseRule(
      source(`---\non: command(gh pr create)\nrequire:\n  - gate(test)\notherwise: warn\n---\nb`),
    );
    assert.deepEqual("rule" in command ? command.rule.on : null, {
      kind: "command",
      pattern: "gh pr create",
    });

    const bad = parseRule(source(`---\non: whenever\nrequire:\n  - gate(test)\notherwise: warn\n---\nb`));
    assert.ok("error" in bad);
    assert.match("error" in bad ? bad.error.error : "", /unknown trigger/);
  });

  /**
   * hazard: an unknown proof kind must be an error, not a proof that never holds. A rule that cannot be evaluated
   * reads as protection and is not ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  test("AC10 an unknown proof kind is a named error, not a silent never", () => {
    const parsed = parseRule(source(`---\non: pr-open\nrequire:\n  - vibes(good)\notherwise: deny\n---\nb`));

    assert.ok("error" in parsed);
    assert.equal("error" in parsed ? parsed.error.name : "", "review-before-pr");
    assert.match("error" in parsed ? parsed.error.error : "", /unknown proof/);
  });

  test("AC10 a verdict outside the four is refused by name", () => {
    const parsed = parseRule(
      source(`---\non: pr-open\nrequire:\n  - gate(test)\notherwise: explode\n---\nb`),
    );

    assert.ok("error" in parsed);
    assert.match("error" in parsed ? parsed.error.error : "", /deny, ask, follow-up, warn/);
  });

  test("AC10 a rule with no trigger and a rule with no proof are both refused", () => {
    const noTrigger = parseRule(source(`---\nrequire:\n  - gate(test)\notherwise: deny\n---\nb`));
    assert.ok("error" in noTrigger);
    assert.match("error" in noTrigger ? noTrigger.error.error : "", /no `on:` trigger/);

    const noProof = parseRule(source(`---\non: pr-open\notherwise: deny\n---\nb`));
    assert.ok("error" in noProof);
    assert.match("error" in noProof ? noProof.error.error : "", /nothing could ever satisfy/);
  });

  /** why: a rule that exists only to switch a global off has nothing to require, and its body is the reason. */
  test("AC12 a disabled rule may declare no proof, and keeps its body as the reason", () => {
    const parsed = parseRule(
      source(
        `---\non: pr-open\nenabled: false\notherwise: deny\n---\nInfra repo: the team reviews in the PR.`,
      ),
    );

    assert.ok("rule" in parsed, JSON.stringify(parsed));
    assert.equal(parsed.rule.enabled, false);
    assert.match(parsed.rule.body, /Infra repo/);
  });

  test("a file with no frontmatter is refused by name", () => {
    const parsed = parseRule(source("just prose, no fence\n"));

    assert.ok("error" in parsed);
    assert.match("error" in parsed ? parsed.error.error : "", /frontmatter/);
  });
});

describe("buildRuleSet", () => {
  const globalRule = source(
    `---\non: pr-open\nrequire:\n  - subagent(the-jury)\notherwise: deny\n---\nglobal body`,
    {
      tier: "global",
    },
  );

  /**
   * AC12 — the whole point. Writing "always convene the jury" once per repository is the friction this removes,
   * so a global rule has to apply where the project never mentioned it
   * ([/decisions/ad-040.md](/decisions/ad-040.md)).
   */
  test("AC12 a global rule applies in a project that never declared it", () => {
    const set = buildRuleSet([globalRule]);

    assert.equal(set.rules.length, 1);
    assert.equal(set.rules[0]?.tier, "global");
  });

  test("AC12 both tiers apply — this is a union, not a fallback", () => {
    const projectRule = source(
      `---\non: stop\nrequire:\n  - gate(test)\notherwise: follow-up\n---\nproject body`,
      { name: "tests-before-stop" },
    );

    const set = buildRuleSet([globalRule, projectRule]);

    assert.deepEqual(set.rules.map((rule) => rule.name).sort(), ["review-before-pr", "tests-before-stop"]);
  });

  test("AC12 a project rule of the same name replaces the global one", () => {
    const override = source(
      `---\non: pr-open\nrequire:\n  - command(gh pr review)\notherwise: ask\n---\nproject body`,
    );

    const set = buildRuleSet([globalRule, override]);

    assert.equal(set.rules.length, 1);
    assert.equal(set.rules[0]?.tier, "project");
    assert.equal(set.rules[0]?.otherwise, "ask");
    assert.match(set.rules[0]?.body ?? "", /project body/);
  });

  test("AC12 a project rule with enabled:false switches the global off, and is kept for reporting", () => {
    const off = source(`---\non: pr-open\nenabled: false\notherwise: deny\n---\nnot here`, {
      tier: "project",
    });

    const set = buildRuleSet([globalRule, off]);

    assert.deepEqual(set.rules, [], "nothing enforces");
    assert.equal(set.disabled.length, 1, "and doctor can still name it");
    assert.match(set.disabled[0]?.body ?? "", /not here/);
  });

  test("AC10 a malformed rule is collected and the others still apply", () => {
    const broken = source("no fence at all", { name: "broken" });

    const set = buildRuleSet([globalRule, broken]);

    assert.equal(set.rules.length, 1);
    assert.equal(set.errors.length, 1);
    assert.equal(set.errors[0]?.name, "broken");
  });
});
