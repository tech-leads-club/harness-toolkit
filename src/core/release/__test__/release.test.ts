import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  allDecisionFiles,
  type DecisionSummary,
  decisionsDir,
  formatDecisionDigest,
  needsAction,
  readDecision,
  readDecisions,
} from "../release.decisions.ts";
import { readReleaseSeen, writeReleaseSeen } from "../release.seen.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-release-"));
}

function writeDecision(root: string, file: string, fields: Record<string, string>): void {
  const path = join(decisionsDir(root), file);
  mkdirSync(dirname(path), { recursive: true });
  const front = Object.entries(fields)
    .map(([key, value]) => `${key}: "${value}"`)
    .join("\n");
  writeFileSync(
    path,
    `---\ntype: Decision\n${front}\ntags: [decision]\ntimestamp: "2026-08-04"\n---\n\n# body\n`,
  );
}

test("a decision without a migration note is read as needing no action", () => {
  const root = tempRoot();
  try {
    writeDecision(root, "ad-001.md", { title: "AD-001 — Something", description: "d" });
    const decision = readDecision(root, "ad-001.md");
    assert.equal(decision?.id, "AD-001");
    assert.equal(decision?.migration, undefined);
    assert.deepEqual(needsAction([decision as DecisionSummary]), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: the note is what marks a decision as needing operator action. Anything finer would be the harness guessing
// whether a given config is affected, which `doctor` answers precisely.
test("a decision with a migration note is read as needing action, carrying its text", () => {
  const root = tempRoot();
  try {
    writeDecision(root, "ad-002.md", {
      title: "AD-002 — Broke a thing",
      description: "d",
      migration: "Change X to Y.",
    });
    const decision = readDecision(root, "ad-002.md") as DecisionSummary;
    assert.equal(decision.migration, "Change X to Y.");
    assert.deepEqual(needsAction([decision]), [decision]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing file and a file with no title are both absent rather than throwing", () => {
  const root = tempRoot();
  try {
    assert.equal(readDecision(root, "ad-404.md"), null);
    const path = join(decisionsDir(root), "ad-003.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "no frontmatter here\n");
    assert.equal(readDecision(root, "ad-003.md"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: an absent docs directory is an empty list. A linked checkout may carry no docs at all, and that is not a fault.
test("an absent decisions directory yields no files and no decisions", () => {
  const root = tempRoot();
  try {
    assert.deepEqual(allDecisionFiles(root), []);
    assert.deepEqual(readDecisions(root, ["ad-001.md"]), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only ad-NNN files count, so an index or a note is never announced as a decision", () => {
  const root = tempRoot();
  try {
    writeDecision(root, "ad-001.md", { title: "AD-001 — One", description: "d" });
    const index = join(decisionsDir(root), "index.md");
    writeFileSync(index, '---\ntype: Concept\ntitle: "Index"\n---\n');
    assert.deepEqual(allDecisionFiles(root), ["ad-001.md"]);
    assert.deepEqual(
      readDecisions(root, ["ad-001.md", "index.md", "log.md"]).map((d) => d.id),
      ["AD-001"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// invariant: what needs action comes first and carries the note. A note the operator scrolls past is a note that did
// not arrive. The heading wording changed under AD-034; the ordering invariant did not.
test("the digest puts what needs action first, with its instruction", () => {
  const digest = formatDecisionDigest([
    { id: "AD-001", title: "AD-001 — Quiet one" },
    { id: "AD-002", title: "AD-002 — Loud one", migration: "Run the thing." },
  ]);
  assert.match(digest, /cannot detect for you \(1\)/);
  assert.ok(
    digest.indexOf("Run the thing.") < digest.indexOf("AD-001"),
    "the actionable one must come first",
  );
  assert.match(digest, /Also landed: AD-001/);
});

test("a digest with nothing in it is empty, so an update with no decisions prints nothing", () => {
  assert.equal(formatDecisionDigest([]), "");
});

test("a digest where nothing needs action omits the action heading entirely", () => {
  const digest = formatDecisionDigest([{ id: "AD-001", title: "AD-001 — Quiet" }]);
  assert.doesNotMatch(digest, /cannot detect/);
  assert.match(digest, /1 decision\(s\) landed/);
});

// why: the title already carries its own id, and printing both read as a stutter in the first draft.
test("the digest does not repeat the decision id", () => {
  const digest = formatDecisionDigest([{ id: "AD-025", title: "AD-025 — Something" }]);
  assert.equal(digest.split("AD-025").length - 1, 1);
});

test("the seen revision round-trips, and an absent marker is null rather than a default", async () => {
  const root = tempRoot();
  try {
    assert.equal(readReleaseSeen(root), null);
    await writeReleaseSeen(root, "abc1234");
    assert.equal(readReleaseSeen(root)?.revision, "abc1234");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt seen marker reads as absent rather than throwing on the update path", async () => {
  const root = tempRoot();
  try {
    await writeReleaseSeen(root, "abc1234");
    const path = join(root, ".tlc", "harness", "state", "release-seen.json");
    writeFileSync(path, "{ not json");
    assert.equal(readReleaseSeen(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// hazard: this asserted that all three breaks carried a note. Two of the three are conditions `doctor` reports on its
// own, and a note repeating a doctor row is the alarm that cries wolf — AD-034 removed them. What survives is the one
// change nothing can detect for the operator.
test("the break doctor cannot detect carries a note, and the ones it can do not", () => {
  const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
  assert.ok((readDecision(repoRoot, "ad-027.md")?.migration ?? "").length > 40);
  for (const detectable of ["ad-025.md", "ad-029.md", "ad-032.md", "ad-033.md"]) {
    assert.equal(readDecision(repoRoot, detectable)?.migration, undefined, detectable);
  }
});

// hazard: an escaped quote inside a frontmatter value survived the outer-quote strip and reached the operator as a
// literal backslash in their terminal. Seen in a real update run ([/decisions/ad-034.md](/decisions/ad-034.md)).
test("an escaped quote in a note does not reach the operator as a backslash", () => {
  const root = tempRoot();
  try {
    writeDecision(root, "ad-010.md", {
      title: "AD-010 — Quoting",
      description: "d",
      migration: 'It said \\"detected but not wired\\" before.',
    });
    const note = readDecision(root, "ad-010.md")?.migration ?? "";
    assert.equal(note.includes("\\"), false, note);
    assert.match(note, /"detected but not wired"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// hazard: the digest led with each decision's title — the author's reasoning, not the operator's situation — and
// printed a shouting heading for every note. In a real run both notes said "run doctor", which update then did three
// lines later, and neither applied to that project. An alarm on every update is one the reader scrolls past.
test("the note is the headline and the decision id trails it", () => {
  const digest = formatDecisionDigest([
    {
      id: "AD-002",
      title: "AD-002 — Some internal reasoning nobody asked about",
      migration: "Do the thing.",
    },
  ]);
  assert.ok(digest.indexOf("Do the thing.") < digest.indexOf("AD-002"), "the note must come first");
  assert.equal(digest.includes("Some internal reasoning"), false, "the title is not the operator's business");
  assert.match(digest, /\(AD-002\)/);
});

test("the heading says what a note now means, and appears only when there is one", () => {
  const withNote = formatDecisionDigest([{ id: "AD-002", title: "AD-002 — X", migration: "Do it." }]);
  assert.match(withNote, /doctor cannot detect for you/);

  const without = formatDecisionDigest([{ id: "AD-002", title: "AD-002 — X" }]);
  assert.doesNotMatch(without, /cannot detect/);
  assert.doesNotMatch(without, /NEEDS YOUR ACTION/i);
});

// why: the header points at doctor rather than repeating it, because update runs doctor immediately after.
test("the digest points at the doctor run instead of asking for it", () => {
  const digest = formatDecisionDigest([{ id: "AD-002", title: "AD-002 — X" }]);
  assert.match(digest, /doctor runs below/);
});

test("decisions needing nothing collapse to a line of ids, not a list of titles", () => {
  const digest = formatDecisionDigest([
    { id: "AD-002", title: "AD-002 — First" },
    { id: "AD-003", title: "AD-003 — Second" },
  ]);
  assert.match(digest, /Also landed: AD-002, AD-003/);
  assert.equal(digest.includes("First"), false);
});

/**
 * invariant: a note exists only where doctor cannot see the condition. Five of the first six repeated a doctor
 * row, which is what AD-034 removed. The list is asserted rather than counted, so adding a note is a deliberate
 * edit here and never a side effect of writing a decision.
 */
test("only the decisions doctor cannot see for you carry a note", () => {
  const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
  const all = readDecisions(repoRoot, allDecisionFiles(repoRoot));
  const withNotes = needsAction(all).map((decision) => decision.id);
  // AD-027: a blocked stop, invisible in advance. AD-058: a gate that starts firing where it was silent, on
  // turns that commit and in languages it never covered — no configuration changed, so nothing detects it.
  assert.deepEqual(withNotes, ["AD-027", "AD-058"]);
  for (const decision of needsAction(all)) {
    assert.ok((decision.migration ?? "").length > 20, `${decision.id} has a note that says nothing`);
    assert.doesNotMatch(
      decision.migration ?? "",
      /run `?tlc harness doctor/i,
      `${decision.id} repeats doctor`,
    );
  }
});
