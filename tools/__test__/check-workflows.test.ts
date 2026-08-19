import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkUses,
  checkWorkflows,
  report,
  type UseSite,
  usesInWorkflow,
  workflowFiles,
} from "../dev/check-workflows.ts";

const repoRoot = join(import.meta.dirname, "..", "..");

const PINNED = "3d3c42e5aac5ba805825da76410c181273ba90b1";

function site(ref: string, rest = ""): UseSite {
  return { file: ".github/workflows/ci.yml", line: 7, ref, rest };
}

test("AC a third-party action referenced by tag is refused, naming what to do", () => {
  const violations = checkUses([site("actions/checkout@v4")]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, "unpinned-action");
  assert.match(violations[0]?.detail ?? "", /is a tag/);
  assert.match(violations[0]?.detail ?? "", /40-character commit SHA/);
});

test("an action with no ref at all is refused", () => {
  assert.deepEqual(
    checkUses([site("actions/checkout")]).map((violation) => violation.rule),
    ["unpinned-action"],
  );
});

test("a SHA pin with the version in a comment is accepted", () => {
  assert.deepEqual(checkUses([site(`actions/checkout@${PINNED}`, " # v7.0.1")]), []);
});

/**
 * why: forty characters say nothing about what you are on, so bumping an action would mean resolving the SHA by
 * hand. The comment is the only readable half of a pin.
 */
test("a SHA pin without a version comment is refused separately", () => {
  const violations = checkUses([site(`actions/checkout@${PINNED}`)]);

  assert.deepEqual(
    violations.map((violation) => violation.rule),
    ["pin-without-version"],
  );
});

/** invariant: a local workflow is this repository at this commit, so there is nothing a pin could defend against. */
test("a local reusable workflow is exempt rather than reported", () => {
  assert.deepEqual(checkUses([site("./.github/workflows/ci.yml")]), []);
});

test("uses lines are found with their line numbers, in both list and mapping form", () => {
  const body = [
    "jobs:",
    "  test:",
    "    steps:",
    "      - uses: a/b@sha # v1",
    "        uses: c/d@sha # v2",
  ].join("\n");

  assert.deepEqual(
    usesInWorkflow("f.yml", body).map((found) => [found.line, found.ref]),
    [
      [4, "a/b@sha"],
      [5, "c/d@sha"],
    ],
  );
});

test("this repository's own workflows are all pinned", () => {
  assert.deepEqual(checkWorkflows(repoRoot), []);
});

test("the workflow files are discovered, and there is at least one", () => {
  const files = workflowFiles(repoRoot);
  assert.ok(files.length > 0, "no workflow files found");
  assert.ok(files.every((entry) => entry.file.startsWith(".github/workflows/")));
});

test("report names each violation with file and line, and says what held when there are none", () => {
  assert.equal(report([], 12).ok, true);
  assert.match(report([], 12).text, /12 action reference\(s\)/);

  const printed = report(checkUses([site("actions/checkout@v4")]), 12);
  assert.equal(printed.ok, false);
  assert.match(printed.text, /ci\.yml:7/);
});
