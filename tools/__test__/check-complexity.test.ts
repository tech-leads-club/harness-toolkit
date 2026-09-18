import assert from "node:assert/strict";
import { test } from "node:test";
import { type BiomeReport, complexityViolations, formatReport } from "../dev/check-complexity.ts";

function report(categories: readonly string[]): BiomeReport {
  return {
    diagnostics: categories.map((category, index) => ({
      category,
      message: `finding ${index}`,
      location: { path: `f${index}.ts`, start: { line: index + 1 } },
    })),
  };
}

test("complexityViolations counts only the complexity category, not other lint findings", () => {
  const found = complexityViolations(
    report([
      "lint/complexity/noExcessiveCognitiveComplexity",
      "lint/style/noVar",
      "lint/complexity/noExcessiveCognitiveComplexity",
    ]),
  );
  assert.equal(found.length, 2);
});

test("complexityViolations returns nothing for a report with no diagnostics field", () => {
  assert.deepEqual(complexityViolations({}), []);
});

test("formatReport is ok at exactly the ceiling", () => {
  const violations = complexityViolations(
    report([
      "lint/complexity/noExcessiveCognitiveComplexity",
      "lint/complexity/noExcessiveCognitiveComplexity",
    ]),
  );
  assert.match(formatReport(violations, 2), /^check-complexity: ok \(2\/2\)$/);
});

test("formatReport fails one violation past the ceiling, naming the file and line", () => {
  const violations = complexityViolations(
    report([
      "lint/complexity/noExcessiveCognitiveComplexity",
      "lint/complexity/noExcessiveCognitiveComplexity",
    ]),
  );
  const text = formatReport(violations, 1);
  assert.match(text, /2 violation\(s\), ceiling is 1/);
  assert.match(text, /f0\.ts:1/);
  assert.match(text, /f1\.ts:2/);
});
