import assert from "node:assert/strict";
import { test } from "node:test";
import {
  duplicationMessage,
  findDuplications,
  indexRuns,
  isCodeLine,
  MIN_LINE_CHARS,
  MIN_RUN,
  normaliseLine,
  type SourceLine,
} from "../duplication.service.ts";

function source(file: string, body: string, startAt = 1): SourceLine[] {
  return body.split("\n").map((text, index) => ({ file, line: startAt + index, text }));
}

const LOGIC = `const resolved = resolveHome(env);
if (resolved === null) { throw new Error("no home"); }
const config = readConfig(resolved);
const merged = mergeDefaults(config, DEFAULTS);
validate(merged);
return merged;`;

test("a run of logic added where the project already has it is found, with both sites", () => {
  const project = indexRuns([...source("old.ts", LOGIC), ...source("other.ts", "const x = 1;\n")]);
  const added = source("new.ts", LOGIC);
  const hits = findDuplications(added, indexRuns([...source("old.ts", LOGIC), ...added]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.file, "new.ts");
  assert.equal(hits[0]?.matchFile, "old.ts");
  assert.equal(project.size > 0, true);
});

test("indentation and a trailing comma are not the difference between two copies", () => {
  const original = source("a.ts", LOGIC);
  const reindented = source(
    "b.ts",
    LOGIC.split("\n")
      .map((line) => `      ${line}`)
      .join("\n"),
  );
  const hits = findDuplications(reindented, indexRuns([...original, ...reindented]));
  assert.equal(hits.length, 1, "the same code at a different indent is the same code");
});

test("renaming an identifier makes it a different run, deliberately", () => {
  const original = source("a.ts", LOGIC);
  const renamed = source("b.ts", LOGIC.replace(/merged/g, "settings"));
  assert.deepEqual(findDuplications(renamed, indexRuns([...original, ...renamed])), []);
});

/**
 * hazard: the first calibration reported 137 runs and the top of the list was every import block in the
 * repository. A dependency declaration is identical in every file that needs the same thing, by design.
 */
test("a repeated block of dependency declarations is not a duplication", () => {
  const imports = `import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";`;
  const a = source("a.test.ts", imports);
  const b = source("b.test.ts", imports);
  assert.deepEqual(findDuplications(b, indexRuns([...a, ...b])), []);
});

/**
 * hazard: with imports excluded the count was still 116, and every one was data — a re-export list, a config
 * literal, a type's fields, a fixture. Repeated shape is what those are for.
 */
test("a repeated object literal, type body or export list is not a duplication", () => {
  const data = [
    `maxInjectSession: 5;
maxInjectRetry: 8;
maxCharsSession: 900;
maxCharsRetry: 1400;
promoteHitCount: 2;
decayLambda: 0.02;`,
    `plan_paths?: string[];
plan_at?: string;
plan_snippet?: string;
plan_deviations?: PlanDeviation[];
next_action?: string;
blockers?: string;`,
  ];
  for (const body of data) {
    const a = source("a.ts", body);
    const b = source("b.ts", body);
    assert.deepEqual(findDuplications(b, indexRuns([...a, ...b])), [], body.split("\n")[0]);
  }
});

test("a comment block repeated verbatim is not a duplicated implementation", () => {
  const licence = `// Copyright the authors of this project.
// Licensed under the terms in LICENSE.
// This file is part of the harness runtime.
// Redistribution is governed by that licence.
// No warranty is expressed or implied.
// See NOTICE for third-party terms.`;
  const a = source("a.ts", licence);
  const b = source("b.ts", licence);
  assert.deepEqual(findDuplications(b, indexRuns([...a, ...b])), []);
});

test("a run shorter than the window is not reported", () => {
  const short = LOGIC.split("\n")
    .slice(0, MIN_RUN - 1)
    .join("\n");
  const a = source("a.ts", short);
  const b = source("b.ts", short);
  assert.deepEqual(findDuplications(b, indexRuns([...a, ...b])), []);
});

// invariant: a run must be contiguous in its own file. Concatenating two files into one array must not create a
// run that exists in neither.
test("a run never spans two files, however they were concatenated", () => {
  const halves = [
    ...source("a.ts", LOGIC.split("\n").slice(0, 3).join("\n")),
    ...source("b.ts", LOGIC.split("\n").slice(3).join("\n")),
  ];
  assert.equal(indexRuns(halves).size, 0);
});

test("a run never spans a skipped line inside one file", () => {
  const withHole = LOGIC.split("\n");
  withHole.splice(3, 0, "}");
  const lines = source("a.ts", withHole.join("\n"));
  assert.equal(indexRuns(lines).size, 0, "the brace breaks the run rather than being skipped over");
});

test("a run matching only itself is not a finding", () => {
  const only = source("a.ts", LOGIC);
  assert.deepEqual(findDuplications(only, indexRuns(only)), []);
});

test("normalisation drops what a paste changes and keeps what it does not", () => {
  assert.equal(normaliseLine("   const a = compute(b);   "), "const a = compute(b);");
  assert.equal(normaliseLine("const  a   =  compute(b),"), "const a = compute(b)");
  assert.equal(normaliseLine("}"), null);
  assert.equal(normaliseLine("a".repeat(MIN_LINE_CHARS - 1)), null);
  assert.equal(normaliseLine("a".repeat(MIN_LINE_CHARS)), "a".repeat(MIN_LINE_CHARS));
});

test("a dependency line and a comment are both excluded from a run", () => {
  assert.equal(isCodeLine('import { join } from "node:path";', "a.ts"), false);
  assert.equal(isCodeLine("// why: something", "a.ts"), false);
  assert.equal(isCodeLine("const a = compute(b);", "a.ts"), true);
  // invariant: an unknown extension still contributes code lines, because refusing to index it would make the
  // rail silently blind to whole languages rather than loudly wrong about one.
  assert.equal(isCodeLine("const a = compute(b);", "a.unknownext"), true);
});

test("the message names both sites and caps what it prints", () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    file: `f${index}.ts`,
    line: index,
    matchFile: "old.ts",
    matchLine: 3,
    runLength: MIN_RUN,
  }));
  const text = duplicationMessage(many);
  assert.equal(text.includes("14 run(s)"), true);
  assert.equal(text.split("\n").filter((line) => line.includes("already at")).length, 10);
  assert.equal(text.includes("say which, in one line, and continue"), true);
});

/**
 * hazard: the first calibration reported zero duplications at every window length, which read as a clean
 * repository and was a defect — the index kept one site per run, so when the new copy happened to be indexed
 * first the run compared equal to itself and vanished. File order is whatever `git ls-files` returns, so the new
 * copy coming first is not a corner case.
 */
test("a duplication is found whichever copy the project index reached first", () => {
  const original = source("old.ts", LOGIC);
  const copy = source("new.ts", LOGIC);
  for (const [label, index] of [
    ["original first", indexRuns([...original, ...copy])],
    ["copy first", indexRuns([...copy, ...original])],
  ] as const) {
    const hits = findDuplications(copy, index);
    assert.equal(hits.length, 1, label);
    assert.equal(hits[0]?.matchFile, "old.ts", label);
  }
});
