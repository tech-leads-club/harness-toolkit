import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_FACING,
  classifyOccurrence,
  findUnwired,
  formatFindings,
  parseInventories,
  trackedSourceFiles,
} from "../dev/check-wiring.ts";

function roleOf(line: string, member: string): string {
  const at = line.indexOf(`"${member}"`);
  assert.ok(at >= 0, `member ${member} not present in fixture`);
  return classifyOccurrence(line.slice(0, at));
}

test("a single-line literal union is discovered with every member", () => {
  const found = parseInventories("t.ts", 'export type Mode = "a" | "b" | "c";');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.typeName, "Mode");
  assert.deepEqual(found[0]?.members, ["a", "b", "c"]);
});

test("a multi-line union with a leading pipe is discovered", () => {
  const text = ["export type Kind =", '  | "one"', '  | "two";'].join("\n");
  assert.deepEqual(parseInventories("t.ts", text)[0]?.members, ["one", "two"]);
});

test("a union of non-literals is not an inventory", () => {
  assert.deepEqual(parseInventories("t.ts", "export type Value = string | number;"), []);
});

test("a non-exported union is not an inventory", () => {
  assert.deepEqual(parseInventories("t.ts", 'type Local = "a" | "b";'), []);
});

test("a field assignment is a producer", () => {
  assert.equal(roleOf('kind: "gate.outcome",', "gate.outcome"), "producer");
});

test("a map value is a producer", () => {
  assert.equal(classifyOccurrence('  "session.start": '), "producer");
});

test("a return is a producer", () => {
  assert.equal(roleOf('return "path-missing";', "path-missing"), "producer");
});

// hazard: a bare positional argument is a producer, and reading it as a consumer was the only false positive in
// the whole corpus when this check was first measured.
test("a positional argument is a producer", () => {
  assert.equal(roleOf('appendSpoolRecord(root, "audit", record);', "audit"), "producer");
});

test("an equality comparison is a consumer", () => {
  assert.equal(roleOf('event.kind === "gate.outcome"', "gate.outcome"), "consumer");
});

test("a switch case is a consumer", () => {
  assert.equal(roleOf('    case "infra":', "infra"), "consumer");
});

test("a set membership test is a consumer", () => {
  assert.equal(roleOf('SIGNAL_KINDS.has("policy.deny")', "policy.deny"), "consumer");
});

// hazard: the producer alternatives `=` and `(` would otherwise match the tail of `===` and the head of
// `includes(`. Either hole reads a comparison as a write, and every dead rail this check exists to catch is
// compared somewhere — so the check would have passed on all of them.
test("a comparison is never also read as a producer", () => {
  assert.equal(roleOf('if (kind === "x") {}', "x"), "consumer");
  assert.equal(roleOf('if (kind !== "x") {}', "x"), "consumer");
  assert.equal(roleOf('if (list.includes("x")) {}', "x"), "consumer");
  assert.equal(roleOf('if (set.has("x")) {}', "x"), "consumer");
});

// invariant: membership in a collection literal is not a read. The same syntax declares an inventory, and
// counting it as a read produced noise on 66% of the corpus.
test("membership in an array literal is a producer, never a read", () => {
  assert.equal(roleOf('const RAILS = ["comments"];', "comments"), "producer");
});

test("a bare occurrence with no operator is ambiguous and counts as neither", () => {
  assert.equal(roleOf('  "orphan"', "orphan"), "ambiguous");
});

test("a member that is read and never written is a finding", () => {
  const inventories = parseInventories("types.ts", 'export type Cat = "wired" | "orphan";');
  const corpus = new Map([
    ["types.ts", 'export type Cat = "wired" | "orphan";'],
    ["produce.ts", 'const c = { category: "wired" };'],
    ["consume.ts", 'if (c.category === "wired") {}\nif (c.category === "orphan") {}'],
  ]);
  const findings = findUnwired(inventories, corpus);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.member, "orphan");
  assert.deepEqual(findings[0]?.consumedIn, ["consume.ts"]);
});

// why: written and never read is dead data, not the defect this catches. The failure mode being refused is a
// consumer whose default value is plausible, which reads as working.
test("a member that is written and never read is not a finding", () => {
  const inventories = parseInventories("types.ts", 'export type Cat = "only-written";');
  const corpus = new Map([
    ["types.ts", 'export type Cat = "only-written";'],
    ["produce.ts", 'const c = { category: "only-written" };'],
  ]);
  assert.deepEqual(findUnwired(inventories, corpus), []);
});

test("a producer in the declaring file counts, so a self-contained union is wired", () => {
  const text = [
    'export type Cat = "a";',
    'export function make(): Cat { return "a"; }',
    'export const isA = (c: Cat) => c === "a";',
  ].join("\n");
  assert.deepEqual(findUnwired(parseInventories("self.ts", text), new Map([["self.ts", text]])), []);
});

test("the clean report states how many members were checked", () => {
  assert.match(
    formatFindings([], 128),
    /^check-wiring: 128 declared union members, every consumed member has a producer/,
  );
});

// invariant: an escape hatch that says nothing reads as a passing check (AD-034), so every unchecked union is
// named with its reason in the clean report.
test("the clean report names every union it did not check, and why", () => {
  const report = formatFindings([], 128);
  for (const [type, reason] of CONFIG_FACING) {
    assert.ok(report.includes(`not checked: ${type} — ${reason}`), `${type} missing from the report`);
  }
});

// hazard: the escape hatch is per union, so it can state that a whole type is operator-supplied but cannot hide
// one dead member of an internal union.
test("a config-facing union is skipped whole rather than member by member", () => {
  const text = 'export type CommentMode = "declared" | "strict";';
  assert.ok(CONFIG_FACING.has("CommentMode"));
  const corpus = new Map([
    ["policy.types.ts", text],
    ["reader.ts", 'if (mode === "strict") {}'],
  ]);
  assert.deepEqual(findUnwired(parseInventories("policy.types.ts", text), corpus), []);
});

test("a finding report names the type, the member, the declaration and each reader", () => {
  const report = formatFindings(
    [{ typeName: "Cat", member: "orphan", declaredIn: "types.ts", consumedIn: ["a.ts", "b.ts"] }],
    10,
  );
  assert.match(report, /1 of 10 declared union members are read and never written/);
  assert.match(report, /Cat\.orphan {2}\(declared in types\.ts\)/);
  assert.match(report, /read by a\.ts/);
  assert.match(report, /read by b\.ts/);
  assert.match(report, /Either write it somewhere, or delete the member/);
});

// hazard: listing only the index made a file added in the current change invisible, so its own producer did not
// count and its brand-new union member was reported as unproduced.
test("the corpus includes not-yet-staged files and excludes test files", () => {
  const files = trackedSourceFiles(process.cwd());
  assert.ok(files.length > 50);
  assert.equal(
    files.some((file) => file.includes("__test__")),
    false,
  );
  assert.ok(files.includes("src/core/lesson/lesson.types.ts"));
  // why: this file is in the same change as the union member it produces, so it proves the untracked case.
  assert.ok(files.includes("src/core/lesson/lesson.credit.ts"));
});

// invariant: inventories are discovered, never registered — a new union type is covered by existing.
test("this repository's own union types are discovered without registration", () => {
  const inventories = parseInventories(
    "src/core/lesson/lesson.types.ts",
    'export type LessonTier = "core" | "global" | "project";',
  );
  assert.deepEqual(inventories[0]?.members, ["core", "global", "project"]);
});
