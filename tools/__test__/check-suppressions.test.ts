import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSuppressions,
  formatFindings,
  isInComment,
  judge,
  parseSuppression,
} from "../dev/check-suppressions.ts";

function at(text: string) {
  return parseSuppression("f.ts", 1, text);
}

function verdict(text: string) {
  const parsed = at(text);
  return parsed === null ? null : judge(parsed);
}

test("a suppression with a declared reason passes", () => {
  assert.equal(
    verdict("// biome-ignore lint/style/noVar: why: the vendor payload arrives as a var declaration"),
    null,
  );
});

test("a suppression with no reason at all is reported", () => {
  const finding = verdict("// biome-ignore lint/style/noVar:");
  assert.match(finding?.detail ?? "", /no reason given/);
});

/**
 * hazard: this is the whole point. Biome 2 already requires text after the colon, so `: needed` parses and tells a
 * reader nothing ([/decisions/ad-051.md](/decisions/ad-051.md)).
 */
test("a reason that is a word rather than a reason is reported", () => {
  assert.match(verdict("// biome-ignore lint/style/noVar: needed")?.detail ?? "", /must open with/);
});

test("a declared prefix with nothing behind it is reported", () => {
  assert.match(verdict("// biome-ignore lint/style/noVar: why: needed")?.detail ?? "", /words or fewer/);
});

test("@ts-expect-error is held to the same reason", () => {
  assert.match(verdict("// @ts-expect-error needed")?.detail ?? "", /must open with/);
  assert.equal(verdict("// @ts-expect-error why: the vendor types omit this optional field"), null);
});

// invariant: a file-wide disable is never justified here, whatever reason is attached.
test("@ts-nocheck is reported even with a declared reason", () => {
  assert.match(
    verdict("// @ts-nocheck why: this generated file has thousands of errors")?.detail ?? "",
    /whole file/,
  );
});

/**
 * hazard: the first version of this check reported three findings and every one was a string literal in the
 * comment-policy tests, which must contain a directive to assert that directives are exempt. A checker whose
 * findings are all noise gets switched off.
 */
test("a directive inside a string literal is not a suppression", () => {
  assert.equal(at('  "// biome-ignore lint/style/noVar: needed",'), null);
  assert.equal(at('    { file: "a.ts", line: 1, text: "// biome-ignore lint/style/noVar: needed" },'), null);
});

// invariant: the control for the test above — the same text in a real comment is still caught.
test("the same text in a real comment is still caught", () => {
  assert.notEqual(at("// biome-ignore lint/style/noVar: needed"), null);
});

test("a trailing comment after a string still counts", () => {
  const parsed = at('const a = "x"; // biome-ignore lint/style/noVar: needed');
  assert.notEqual(parsed, null);
  assert.equal(parsed?.reason, "needed");
});

test("isInComment rejects an odd number of quotes before the directive", () => {
  assert.equal(isInComment('"// biome-ignore', 3), false);
  assert.equal(isInComment("// biome-ignore", 3), true);
});

test("a file with nothing to suppress reports nothing", () => {
  const findings = findSuppressions(["a.ts"], (() => "const a = 1;\n") as never);
  assert.deepEqual(findings, []);
});

test("the report names the file, the line and the directive", () => {
  const findings = findSuppressions(["a.ts"], (() => "// biome-ignore lint/style/noVar: needed\n") as never);
  const text = formatFindings(findings, 1);
  assert.match(text, /a\.ts:1/);
  assert.match(text, /\[biome-ignore\]/);
});

// invariant: the clean line states how many files were scanned, so a run that matched nothing because it read
// nothing is distinguishable from a clean repo.
test("the clean report says how many files it read", () => {
  assert.match(formatFindings([], 267), /0 unjustified in 267 files/);
});
