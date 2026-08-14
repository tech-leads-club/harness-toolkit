import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  apiKeyFrom,
  buildRoutingPrompt,
  DEFAULT_MODEL,
  loadCases,
  modelFrom,
  parseVerdict,
  scoreAnswers,
  skillFrontmatter,
  type TriggerCase,
} from "../dev/eval-skill-triggers.ts";

describe("skillFrontmatter", () => {
  test("reads the shipped skill's name and description", () => {
    const skill = skillFrontmatter();
    assert.equal(skill.name, "harness-init");
    assert.ok(skill.description.includes("setup harness"));
    assert.ok(skill.description.includes("Do NOT use for"));
  });

  test("collapses the description to one line so the prompt is stable", () => {
    assert.equal(skillFrontmatter().description.includes("\n"), false);
  });
});

describe("buildRoutingPrompt", () => {
  const skill = { name: "harness-init", description: "wizard that connects a repo" };

  test("carries the skill name, its description and the query verbatim", () => {
    const prompt = buildRoutingPrompt(skill, "setup harness");
    assert.ok(prompt.includes("harness-init"));
    assert.ok(prompt.includes("wizard that connects a repo"));
    assert.ok(prompt.includes('"setup harness"'));
  });

  test("demands a one-word verdict, which is what parseVerdict reads", () => {
    assert.match(buildRoutingPrompt(skill, "x"), /exactly one word: YES or NO/);
  });
});

describe("parseVerdict", () => {
  test("reads YES and NO regardless of case or surrounding whitespace", () => {
    assert.equal(parseVerdict("YES"), true);
    assert.equal(parseVerdict(" yes\n"), true);
    assert.equal(parseVerdict("No."), false);
  });

  test("returns null on anything it cannot read, rather than guessing", () => {
    assert.equal(parseVerdict("maybe"), null);
    assert.equal(parseVerdict(""), null);
  });
});

describe("scoreAnswers", () => {
  const cases: TriggerCase[] = [
    { query: "setup harness", should_trigger: true },
    { query: "harness status", should_trigger: false },
  ];

  test("counts a match on both polarities as a pass", () => {
    const outcome = scoreAnswers(cases, [
      { query: "setup harness", triggered: true },
      { query: "harness status", triggered: false },
    ]);
    assert.equal(outcome.passed, 2);
    assert.equal(outcome.failed, 0);
    assert.equal(outcome.passRate, 1);
    assert.deepEqual(outcome.failures, []);
  });

  test("a wrong polarity is a failure that names both sides", () => {
    const outcome = scoreAnswers(cases, [
      { query: "setup harness", triggered: true },
      { query: "harness status", triggered: true },
    ]);
    assert.equal(outcome.passed, 1);
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.passRate, 0.5);
    assert.deepEqual(outcome.failures, [
      { query: "harness status", expected: false, actual: true, note: undefined },
    ]);
  });

  // hazard: an unreadable answer must not be scored as agreement. Counting it as a pass would let a broken
  // model or a truncated response report a perfect run.
  test("an unreadable answer counts as failed and unanswered, never as a pass", () => {
    const outcome = scoreAnswers(cases, [
      { query: "setup harness", triggered: null },
      { query: "harness status", triggered: false },
    ]);
    assert.equal(outcome.unanswered, 1);
    assert.equal(outcome.passed, 1);
    assert.equal(outcome.failed, 1);
  });

  test("a missing answer is treated as unanswered rather than skipped", () => {
    const outcome = scoreAnswers(cases, [{ query: "setup harness", triggered: true }]);
    assert.equal(outcome.total, 2);
    assert.equal(outcome.unanswered, 1);
    assert.equal(outcome.passRate, 0.5);
  });
});

describe("apiKeyFrom / modelFrom", () => {
  test("an absent, empty or whitespace key all read as absent", () => {
    assert.equal(apiKeyFrom({}), null);
    assert.equal(apiKeyFrom({ ANTHROPIC_API_KEY: "" }), null);
    assert.equal(apiKeyFrom({ ANTHROPIC_API_KEY: "   " }), null);
  });

  test("a real key is returned trimmed", () => {
    assert.equal(apiKeyFrom({ ANTHROPIC_API_KEY: " sk-test " }), "sk-test");
  });

  test("modelFrom falls back to the default and honours an explicit flag", () => {
    assert.equal(modelFrom([]), DEFAULT_MODEL);
    assert.equal(modelFrom(["--model"]), DEFAULT_MODEL);
    assert.equal(modelFrom(["--model", "claude-opus-5"]), "claude-opus-5");
  });
});

describe("loadCases", () => {
  test("loads the shipped cases, which are the same ones the suite gates", () => {
    const cases = loadCases();
    assert.ok(cases.length >= 10);
    assert.ok(cases.some((testCase) => testCase.should_trigger));
    assert.ok(cases.some((testCase) => !testCase.should_trigger));
  });
});
