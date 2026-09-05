import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { coreFacade } from "../../../core/index.ts";
import { codexCapabilities } from "../codex.capabilities.ts";
import {
  codexLessonsSourcePath,
  codexLessonsViewPath,
  renderCodexLessonsView,
} from "../codex.lessons-view.ts";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-lessons-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function writeLessons(root: string): void {
  const source = codexLessonsSourcePath(root);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, "- always run the gate\n", "utf8");
}

/**
 * spec P4 AC7, the "otherwise" half: nothing is written by default. `sessionStartContextReliable` is true here,
 * so under the default `auto` the verdict is not to write and this view is never called.
 */
test("the default syncRulesFile mode writes no durable file on this host", () => {
  const verdict = coreFacade.lesson.durableViewVerdict(
    "auto",
    codexCapabilities().sessionStartContextReliable,
  );
  assert.equal(verdict.writes, false);
  assert.match(verdict.reason, /session-start hook/);
});

test("syncRulesFile always is what asks for the file, and never does not", () => {
  const reliable = codexCapabilities().sessionStartContextReliable;
  assert.equal(coreFacade.lesson.durableViewVerdict("always", reliable).writes, true);
  assert.equal(coreFacade.lesson.durableViewVerdict("never", reliable).writes, false);
});

// spec P4 AC7: a plain markdown pointer, appended to AGENTS.md.
test("a pointer is appended to AGENTS.md", () => {
  const root = newRoot();
  writeLessons(root);

  const written = renderCodexLessonsView(root);

  assert.equal(written, codexLessonsViewPath(root));
  assert.equal(written, join(root, "AGENTS.md"));
  assert.match(readFileSync(written, "utf8"), /\.tlc\/harness\/lessons\.md/);
});

/**
 * invariant: no `@file` syntax. Codex has no file-import mechanism, and `AGENTS.md` is read by other tools too,
 * so a directive that looks like one and is not is worse than a sentence.
 */
test("the pointer carries no @file import syntax", () => {
  const root = newRoot();
  writeLessons(root);
  const text = readFileSync(renderCodexLessonsView(root) ?? "", "utf8");
  assert.ok(!text.includes("@.tlc"), text);
  assert.doesNotMatch(text, /^@/m);
});

test("nothing is written when there are no lessons to point at", () => {
  const root = newRoot();
  assert.equal(renderCodexLessonsView(root), null);
  assert.equal(existsSync(codexLessonsViewPath(root)), false);
});

test("an existing AGENTS.md is appended to, never replaced", () => {
  const root = newRoot();
  writeLessons(root);
  const path = codexLessonsViewPath(root);
  writeFileSync(path, "# Agents\n\nRun the tests.\n", "utf8");

  renderCodexLessonsView(root);

  const text = readFileSync(path, "utf8");
  assert.match(text, /# Agents/);
  assert.match(text, /Run the tests\./);
  assert.match(text, /\.tlc\/harness\/lessons\.md/);
});

test("a second run leaves the file byte-identical", () => {
  const root = newRoot();
  writeLessons(root);
  renderCodexLessonsView(root);
  const first = readFileSync(codexLessonsViewPath(root), "utf8");

  renderCodexLessonsView(root);

  assert.equal(readFileSync(codexLessonsViewPath(root), "utf8"), first);
});

test("a pointer the operator wrote themselves is left alone", () => {
  const root = newRoot();
  writeLessons(root);
  const path = codexLessonsViewPath(root);
  const theirs = "See .tlc/harness/lessons.md, in my own words.\n";
  writeFileSync(path, theirs, "utf8");

  assert.equal(renderCodexLessonsView(root), path);
  assert.equal(readFileSync(path, "utf8"), theirs);
});
