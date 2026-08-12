import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFindingsFromOutput, FINDINGS_MAX } from "../gate.artifact.ts";
import { classifyLine, filesFromOutput, findingsFromLines, stripAnsi } from "../gate.findings.ts";

// why: the exact output that reached an operator as three separate gaps. 28 pass, 1 fail.
const INCIDENT = `test-dispatch: bun test in bots/platform-agent (1 file(s))
bun test v1.3.14 (0d9b296a)

src/agent/guardrail-runtime.test.ts:
456 |     await runCascade(JOB, d)
458 |     expect(points).toEqual([
                       ^
error: expect(received).toEqual(expected)

@@ -3,3 +3,3 @@
      "dims": {
-       "reason": "topic",
+       "reason": "unknown",

- Expected  - 1
+ Received  + 1

(fail) runCascade — métricas dos sinais de guardrail > sinalizado sem bloqueio emite guardrail.flagged [0.50ms]

 28 pass
 1 fail
 71 expect() calls
Ran 29 tests across 1 file. [433.00ms]`;

test("a tally never stands alone as a finding", () => {
  for (const line of [
    "1 fail",
    "2 failed",
    "Tests: 3 failed, 1 passed",
    "FAILED (failures=2)",
    "✗ 4 tests failed",
    "4 tests failed",
    "Tests:       1 failed, 28 passed",
  ]) {
    assert.equal(classifyLine(line), "count", line);
  }
});

test("a structural marker identifies a failing test across frameworks", () => {
  for (const line of [
    "(fail) runCascade — emite guardrail.flagged [0.50ms]",
    "not ok 1 - the policy surface is guarded",
    "--- FAIL: TestGuardrail (0.00s)",
    "FAIL src/agent/guardrail-runtime.test.ts",
    "✗ emits the flagged metric",
  ]) {
    assert.equal(classifyLine(line), "test", line);
  }
});

test("assertion vocabulary is detail; a bare error is its own failure", () => {
  assert.equal(classifyLine("error: expect(received).toEqual(expected)"), "assertion");
  assert.equal(classifyLine("AssertionError [ERR_ASSERTION]: values differ"), "assertion");
  assert.equal(classifyLine("Expected values to be strictly equal:"), "assertion");
  // hazard: folding this into a neighbouring test would hide a distinct failure as a footnote.
  assert.equal(classifyLine("error: cannot find module './missing'"), "other");
  assert.equal(classifyLine("panic: runtime error: index out of range"), "other");
});

test("a tally carrying a failure name is not a tally", () => {
  // why: the name is the only identity that failure has; dropping the line would drop the failure.
  assert.notEqual(classifyLine("1 fail — runCascade emite guardrail.flagged"), "count");
});

test("the recorded incident yields exactly one finding", () => {
  const findings = extractFindingsFromOutput(INCIDENT, 1);

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.summary ?? "", /runCascade/);
  assert.match(findings[0]?.detail ?? "", /expect\(received\)\.toEqual\(expected\)/);
  // invariant: the tally is not a problem to fix.
  assert.doesNotMatch(findings[0]?.summary ?? "", /^1 fail$/);
});

test("the assertion travels with its test whichever order the runner prints", () => {
  const tapOrder = ["not ok 1 - emits the metric", "AssertionError: values differ"];
  const bunOrder = ["error: expect(a).toEqual(b)", "(fail) emits the metric"];

  for (const lines of [tapOrder, bunOrder]) {
    const findings = findingsFromLines(lines, 1, FINDINGS_MAX);
    assert.equal(findings.length, 1, lines.join(" | "));
    assert.match(findings[0]?.summary ?? "", /emits the metric/);
    assert.ok((findings[0]?.detail ?? "").length > 0, "assertion was not attached as detail");
  }
});

test("two distinct failing tests stay two findings", () => {
  const findings = findingsFromLines(
    ["not ok 1 - first case", "AssertionError: a", "not ok 2 - second case", "AssertionError: b", "2 failed"],
    1,
    FINDINGS_MAX,
  );
  assert.equal(findings.length, 2);
  assert.match(findings[0]?.summary ?? "", /first case/);
  assert.match(findings[1]?.summary ?? "", /second case/);
});

test("the same line twice is one finding", () => {
  const findings = findingsFromLines(["FAIL src/a.test.ts", "FAIL   src/a.test.ts"], 1, FINDINGS_MAX);
  assert.equal(findings.length, 1);
});

test("an unrecognised format still reports its lines", () => {
  // why: prove-safe. An unknown runner degrades to today's behaviour minus the tally, never to silence.
  const findings = findingsFromLines(["ERROR in ./src/x.ts", "panic: boom", "1 failed"], 1, FINDINGS_MAX);
  assert.equal(findings.length, 2);
});

test("an assertion with no test line survives as its own finding", () => {
  const findings = findingsFromLines(["AssertionError: nothing named this"], 1, FINDINGS_MAX);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.summary ?? "", /AssertionError/);
});

test("output that is nothing but tallies still reports the failure", () => {
  const findings = findingsFromLines(["1 fail"], 7, FINDINGS_MAX);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.summary ?? "", /exited with code 7/);
  assert.equal(findings[0]?.detail, "1 fail");
});

test("more failures than the cap disclose how many were omitted", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`);
  const findings = findingsFromLines(lines, 1, FINDINGS_MAX);

  assert.equal(findings.length, FINDINGS_MAX);
  const last = findings[findings.length - 1]?.summary ?? "";
  assert.match(last, /and 5 more failures/);
});

test("exactly at the cap nothing is omitted and no slot is spent disclosing", () => {
  const lines = Array.from({ length: 3 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`);
  const findings = findingsFromLines(lines, 1, 3);

  assert.equal(findings.length, 3);
  assert.doesNotMatch(findings[2]?.summary ?? "", /more failures/);
});

test("one past the cap discloses two, because the disclosure costs a slot", () => {
  // why: pins the real boundary. The disclosure occupies one of `max` slots, so the smallest number it can
  // ever report is two — an "and 1 more" message is unreachable by construction.
  const lines = Array.from({ length: 4 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`);
  const findings = findingsFromLines(lines, 1, 3);

  assert.equal(findings.length, 3);
  assert.match(findings[2]?.summary ?? "", /and 2 more failures/);
});

// why: the shape of the real gate output from the incident, which named three failing test files while the
// diff named one unrelated new file — and the plan pointed the agent at the diff.
// invariant: neutral paths and no operator home. Core is provider-agnostic and a tracked file carries no
// personal identity; both gates caught an earlier draft of this fixture that used the real paths verbatim.
const INCIDENT_PATHS = `test at src/entrypoints/__test__/tool-after.test.ts:366:1
\u2716 the first fetch of the turn is framed as data
      at TestContext.<anonymous> (file:///repo/src/entrypoints/__test__/tool-after.test.ts:374:12)
test at src/entrypoints/__test__/tool-before.test.ts:232:1
\u2716 a spawn's minEffort violation is denied
      at TestContext.<anonymous> (file:///repo/src/entrypoints/__test__/tool-before.test.ts:246:12)
test at src/providers/vendor/__test__/vendor.inbound.test.ts:166:1`;

test("the files come from the failure, and each file appears once", () => {
  const files = filesFromOutput(INCIDENT_PATHS, "/repo");

  assert.deepEqual(files, [
    "src/entrypoints/__test__/tool-after.test.ts",
    "src/entrypoints/__test__/tool-before.test.ts",
    "src/providers/vendor/__test__/vendor.inbound.test.ts",
  ]);
});

test("an absolute path inside the project collapses onto its relative spelling", () => {
  // hazard: node prints both forms for one failure. Without collapsing them the reader is handed two places
  // to look for one problem.
  const files = filesFromOutput("test at src/a.test.ts:1:1\n at (file:///repo/src/a.test.ts:2:2)", "/repo");
  assert.deepEqual(files, ["src/a.test.ts"]);
});

test("a path outside the project is still reported, as printed", () => {
  const files = filesFromOutput("at (file:///elsewhere/src/b.test.ts:3:1)", "/repo");
  assert.deepEqual(files, ["/elsewhere/src/b.test.ts"]);
});

test("output that names no source file yields nothing", () => {
  assert.deepEqual(filesFromOutput("1 fail\n28 pass\nRan 29 tests", "/repo"), []);
  assert.deepEqual(filesFromOutput("", "/repo"), []);
});

/**
 * hazard: a colour escape ends `[39m`, and `39m` matches the path pattern while the escape character does not — so
 * a coloured `src/x.test.ts` was extracted as `39msrc/x.test.ts` and the autopilot named a file that does not
 * exist. Taken from this repository's own gate output.
 */
test("a path in coloured output is named without the escape glued to it", () => {
  const e = String.fromCharCode(27);
  const output = [
    `test at ${e}[90m${e}[39msrc/entrypoints/__test__/tool-after.test.ts:123:1`,
    `${e}[31m✖ a thing failed ${e}[90m(5.5ms)${e}[39m${e}[39m`,
    `    at TestContext.<anonymous> ${e}[90m(file:///repo/${e}[39msrc/core/gate/gate.service.ts:12:3${e}[90m)${e}[39m`,
  ].join("\n");
  assert.deepEqual(filesFromOutput(output, "/repo"), [
    "src/entrypoints/__test__/tool-after.test.ts",
    "src/core/gate/gate.service.ts",
  ]);
});

test("uncoloured output is unchanged, so the fix costs nothing on a plain runner", () => {
  const output = "test at src/a.test.ts:1:1\n  at file:///repo/src/b.ts:2:2";
  assert.deepEqual(filesFromOutput(output, "/repo"), ["src/a.test.ts", "src/b.ts"]);
});

test("stripAnsi removes only escapes, never ordinary bracketed text", () => {
  assert.equal(stripAnsi("[test/verification] plain [90m text"), "[test/verification] plain [90m text");
});
