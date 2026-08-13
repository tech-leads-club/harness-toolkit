import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { datedDecisions, groupByDate, renderLog } from "../render-log.ts";

function fixture(records: { id: string; date?: string; title?: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-render-log-"));
  mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  for (const record of records) {
    const date = record.date === undefined ? "" : `timestamp: "${record.date}"\n`;
    writeFileSync(
      join(root, "docs", "decisions", `${record.id}.md`),
      `---\ntype: Decision\ntitle: "${record.id.toUpperCase()} — ${record.title ?? "A title"}"\n${date}---\n\nbody\n`,
    );
  }
  return root;
}

test("days run newest first and records within a day run in id order", () => {
  const root = fixture([
    { id: "ad-001", date: "2026-07-27" },
    { id: "ad-065", date: "2026-08-12" },
    { id: "ad-064", date: "2026-08-12" },
  ]);
  const grouped = groupByDate(datedDecisions(root));
  assert.deepEqual(
    grouped.map(([date]) => date),
    ["2026-08-12", "2026-07-27"],
  );
  const body = renderLog(datedDecisions(root));
  assert.ok(body.indexOf("AD-064") < body.indexOf("AD-065"), "AD-064 was taken first and reads first");
  assert.ok(body.indexOf("2026-08-12") < body.indexOf("2026-07-27"));
});

// invariant: a record with no timestamp is a bundle violation check-docs-bundle already reports. Filing it under
// a guessed date would hide it.
test("a decision with no timestamp is dropped, never filed under a guessed date", () => {
  const root = fixture([{ id: "ad-001", date: "2026-07-27" }, { id: "ad-002" }]);
  const dated = datedDecisions(root);
  assert.deepEqual(
    dated.map((decision) => decision.id),
    ["AD-001"],
  );
  assert.equal(renderLog(dated).includes("AD-002"), false);
});

test("the id never appears twice in one entry", () => {
  const root = fixture([{ id: "ad-013", date: "2026-07-30", title: "Documentation follows OKF" }]);
  const line = renderLog(datedDecisions(root))
    .split("\n")
    .find((row) => row.startsWith("- **AD-013**"));
  assert.equal(
    line,
    "- **AD-013** — Documentation follows OKF ([/decisions/ad-013.md](/decisions/ad-013.md))",
  );
});

test("every heading is an ISO date, which is what the bundle check requires of a log", () => {
  const root = fixture([
    { id: "ad-001", date: "2026-07-27" },
    { id: "ad-020", date: "2026-08-01" },
  ]);
  const headings = renderLog(datedDecisions(root))
    .split("\n")
    .filter((line) => line.startsWith("## "));
  assert.equal(headings.length, 2);
  for (const heading of headings) {
    assert.match(heading, /^## \d{4}-\d{2}-\d{2}$/);
  }
});

test("rendering the real repository covers every decision record", async () => {
  const { allDecisionFiles } = await import("../../src/core/release/release.decisions.ts");
  const repoRoot = join(import.meta.dirname, "..", "..");
  assert.equal(datedDecisions(repoRoot).length, allDecisionFiles(repoRoot).length);
});
