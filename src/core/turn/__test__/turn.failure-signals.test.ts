import assert from "node:assert/strict";
import { test } from "node:test";
import { formatProgressiveContext, formatScopedEnvNote } from "../turn.failure-signals.ts";

/**
 * why: four stop loops were spent editing code that was not broken, because the suite passed from a shell and
 * failed from inside the hook — the project's gate command omitted the import that neutralises a project-scoping
 * variable. The harness held both halves of that fact and joined neither
 * ([/decisions/ad-060.md](/decisions/ad-060.md)).
 */
const FAILING = {
  maxLoops: 3,
  gate: "test",
  category: "verification" as const,
  gaps: [{ id: "test-0", gate: "test", category: "verification" as const, summary: "x failed" }],
  gateOutput: "boom",
  suggestion: "fix it",
  command: ["node", "--test", "src/**/*.test.ts"],
};

test("the first failure says nothing about the environment", () => {
  const text = formatProgressiveContext({ ...FAILING, loopCount: 0, scopedEnv: ["A_PROJECT_DIR"] });
  assert.doesNotMatch(text, /NOTE: this gate ran with/);
});

test("the second attempt names the variables and how to settle it outside the hook", () => {
  const text = formatProgressiveContext({ ...FAILING, loopCount: 1, scopedEnv: ["A_PROJECT_DIR"] });
  assert.match(text, /NOTE: this gate ran with A_PROJECT_DIR set by the hook/);
  assert.match(text, /Confirm outside the hook before editing/);
  assert.match(text, /node --test src\/\*\*\/\*\.test\.ts/);
  assert.match(text, /only the operator can change it/);
});

// invariant: it states a fact and never claims causation, because nothing here can know it.
test("the note never claims the variable caused the failure", () => {
  const text = formatProgressiveContext({ ...FAILING, loopCount: 2, scopedEnv: ["A_PROJECT_DIR"] });
  assert.doesNotMatch(text, /because of|caused by|is why/);
  assert.match(text, /can be the environment rather than the code/);
});

// hazard: a project-scoping variable is set on every hook invocation under some providers, so an unconditional
// note would fire on every failure forever — the alarm AD-034 removed.
test("with no variable set, no attempt mentions the environment", () => {
  for (const loopCount of [0, 1, 2, 5]) {
    const text = formatProgressiveContext({ ...FAILING, loopCount, scopedEnv: [] });
    assert.doesNotMatch(text, /NOTE: this gate ran with/, `loop ${loopCount}`);
  }
});

test("an artifact written before the field existed is not a crash", () => {
  const text = formatProgressiveContext({ ...FAILING, loopCount: 2 });
  assert.doesNotMatch(text, /NOTE: this gate ran with/);
  assert.equal(formatScopedEnvNote([], []), "");
});
