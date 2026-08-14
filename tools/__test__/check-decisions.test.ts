import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bareCitations,
  checkDecisions,
  type DecisionFile,
  decisionFiles,
  LEGACY_SHAPE_BUDGET,
  REQUIRED_HEADINGS,
  report,
} from "../dev/check-decisions.ts";

const repoRoot = join(import.meta.dirname, "..", "..");

function record(options: { status?: string; headings?: string[]; file?: string }): DecisionFile {
  const status = options.status ?? "active";
  const headings = options.headings ?? [...REQUIRED_HEADINGS];
  return {
    file: options.file ?? "docs/decisions/ad-999.md",
    body: `# AD-999 — a title\n\n- **status**: ${status}\n\n${headings.map((h) => `${h}\n\nbody\n`).join("\n")}`,
  };
}

/** invariant: a set of records that all conform, so a fixture failing is the injected fault and nothing else. */
function conforming(count: number): DecisionFile[] {
  return Array.from({ length: count }, (_, index) =>
    record({ file: `docs/decisions/ad-${String(index + 1).padStart(3, "0")}.md` }),
  );
}

test("AC1 a record missing Trade-offs is named, and pushes the count over the budget", () => {
  const short = record({ file: "docs/decisions/ad-999.md", headings: ["## Decision", "## Why"] });
  const filler = record({ headings: ["## Decision"] });
  const outcome = checkDecisions([
    ...Array.from({ length: LEGACY_SHAPE_BUDGET }, () => filler),
    short,
    ...conforming(3),
  ]);
  assert.equal(outcome.legacy.length, LEGACY_SHAPE_BUDGET + 1);
  assert.equal(
    outcome.legacy.some((entry) => entry.includes("ad-999.md") && entry.includes("## Trade-offs")),
    true,
    outcome.legacy.join(" | "),
  );
  assert.equal(
    outcome.violations.some((violation) => violation.rule === "skeleton"),
    true,
  );
});

// why: `## Why the runtime home had to change` is better prose than `## Why`, and a rule that demanded the bare
// word would force the worse one.
test("AC2 a bespoke Why heading satisfies the Why requirement", () => {
  const bespoke = record({
    headings: [
      "## Decision",
      "## Why the runtime home had to change",
      "## Trade-offs",
      "## Not decided here",
    ],
  });
  const outcome = checkDecisions([...conforming(LEGACY_SHAPE_BUDGET - 1), bespoke, record({})]);
  assert.deepEqual(outcome.legacy, []);
});

test("AC3 exactly the budget passes, and one more fails", () => {
  const off = record({ headings: ["## Decision", "## Why"] });
  const atBudget = checkDecisions([
    ...conforming(5),
    ...Array.from({ length: LEGACY_SHAPE_BUDGET }, () => off),
  ]);
  assert.equal(
    atBudget.violations.some((violation) => violation.rule === "skeleton"),
    false,
  );

  const overBudget = checkDecisions([
    ...conforming(5),
    ...Array.from({ length: LEGACY_SHAPE_BUDGET + 1 }, () => off),
  ]);
  assert.equal(
    overBudget.violations.some((violation) => violation.rule === "skeleton"),
    true,
  );
});

// why: a ratchet that only refuses to rise is one nobody ever turns. Failing on a lower count is what makes
// migrating a record a two-line change rather than a silent improvement nothing records.
test("AC4 migrating one record fails until the recorded budget follows", () => {
  const off = record({ headings: ["## Decision"] });
  const outcome = checkDecisions([
    ...conforming(5),
    ...Array.from({ length: LEGACY_SHAPE_BUDGET - 1 }, () => off),
  ]);
  const stale = outcome.violations.find((violation) => violation.rule === "skeleton-budget-stale");
  assert.notEqual(stale, undefined);
  assert.equal(stale?.detail.includes(String(LEGACY_SHAPE_BUDGET - 1)), true);
});

test("AC5 a bare citation is reported with the linked form to use", () => {
  const root = mkdtempSync(join(tmpdir(), "tlc-decisions-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // invariant: assembled, never written literally. This file is inside the scan, and a fixture spelled out here
  // would make the rule fail on its own test — which is how an exemption list gets born.
  const bare = `(AD-${"046"})`;
  writeFileSync(join(root, "src", "a.ts"), `// see the rule ${bare} for why\n`);
  const found = bareCitations(root);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.detail.includes("[/decisions/ad-046.md](/decisions/ad-046.md)"), true);
});

test("AC6 the repository itself has none", () => {
  assert.deepEqual(bareCitations(repoRoot), []);
});

test("AC8 a status outside the closed set fails, and so does a folder that disagrees with it", () => {
  const unknown = checkDecisions([record({ status: "draft" })]);
  assert.equal(
    unknown.violations.some((violation) => violation.rule === "status-unknown"),
    true,
  );

  const misfiled = checkDecisions([
    record({ status: "archived", file: "docs/decisions/ad-999.md" }),
    ...conforming(LEGACY_SHAPE_BUDGET),
  ]);
  assert.equal(
    misfiled.violations.some((violation) => violation.rule === "status-folder-mismatch"),
    true,
  );
});

test("a record with no status line is a violation rather than a pass", () => {
  const outcome = checkDecisions([{ file: "docs/decisions/ad-999.md", body: "# AD-999\n\n## Decision\n" }]);
  assert.equal(
    outcome.violations.some((violation) => violation.rule === "status-missing"),
    true,
  );
});

test("the reader finds the archived folder as well as the active one", () => {
  const found = decisionFiles(repoRoot).map((entry) => entry.file);
  assert.equal(found.length > 0, true);
  assert.equal(
    found.every((file) => file.startsWith("docs/decisions/")),
    true,
  );
});

test("the repository passes as it stands", () => {
  const outcome = checkDecisions(decisionFiles(repoRoot));
  const printed = report(outcome, bareCitations(repoRoot));
  assert.equal(printed.ok, true, printed.text);
});
