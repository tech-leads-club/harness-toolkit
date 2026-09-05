import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { coreFacade } from "../../../core/index.ts";
import { vscodeCapabilities } from "../vscode.capabilities.ts";
import {
  renderVSCodeLessonsView,
  vscodeLessonsSourcePath,
  vscodeLessonsViewPath,
} from "../vscode.lessons-view.ts";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vscode-lessons-"));
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

function writeLessons(root: string, body = "- always run the gate\n"): void {
  const source = vscodeLessonsSourcePath(root);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, body, "utf8");
}

/**
 * spec P4 AC7, the "otherwise" half: nothing is written by default. `sessionStartContextReliable` is true here,
 * so under the default `auto` the verdict is not to write and this view is never called.
 */
test("the default syncRulesFile mode writes no durable file on this host", () => {
  const verdict = coreFacade.lesson.durableViewVerdict(
    "auto",
    vscodeCapabilities().sessionStartContextReliable,
  );
  assert.equal(verdict.writes, false);
  assert.match(verdict.reason, /session-start hook/);
});

test("syncRulesFile always is what asks for the file, and never does not", () => {
  const reliable = vscodeCapabilities().sessionStartContextReliable;
  assert.equal(coreFacade.lesson.durableViewVerdict("always", reliable).writes, true);
  assert.equal(coreFacade.lesson.durableViewVerdict("never", reliable).writes, false);
});

// spec P4 AC7: the lessons path is appended to `.github/copilot-instructions.md`.
test("the lessons path is appended to .github/copilot-instructions.md", () => {
  const root = newRoot();
  writeLessons(root);

  const written = renderVSCodeLessonsView(root);

  assert.equal(written, vscodeLessonsViewPath(root));
  assert.equal(written, join(root, ".github", "copilot-instructions.md"));
  const text = readFileSync(written, "utf8");
  assert.match(text, /\.tlc\/harness\/lessons\.md/);
});

/**
 * why no `@`: design §9 carried Claude's import syntax across, and nothing in VS Code's or GitHub's documentation
 * describes an import syntax for this file. An `@` line would be inert text that reads as a mechanism.
 */
test("the pointer is plain markdown, with no @file import syntax", () => {
  const root = newRoot();
  writeLessons(root);
  const text = readFileSync(renderVSCodeLessonsView(root) ?? "", "utf8");
  assert.ok(!text.includes("@.tlc"), text);
  assert.doesNotMatch(text, /^@/m);
});

test("nothing is written when there are no lessons to point at", () => {
  const root = newRoot();
  assert.equal(renderVSCodeLessonsView(root), null);
  assert.equal(existsSync(vscodeLessonsViewPath(root)), false);
});

// invariant: this file is the operator's own instructions file.
test("an existing copilot-instructions.md is appended to, never replaced", () => {
  const root = newRoot();
  writeLessons(root);
  const path = vscodeLessonsViewPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# Our instructions\n\nUse tabs.\n", "utf8");

  renderVSCodeLessonsView(root);

  const text = readFileSync(path, "utf8");
  assert.match(text, /# Our instructions/);
  assert.match(text, /Use tabs\./);
  assert.match(text, /\.tlc\/harness\/lessons\.md/);
});

test("a second run leaves the file byte-identical", () => {
  const root = newRoot();
  writeLessons(root);
  renderVSCodeLessonsView(root);
  const first = readFileSync(vscodeLessonsViewPath(root), "utf8");

  renderVSCodeLessonsView(root);

  assert.equal(readFileSync(vscodeLessonsViewPath(root), "utf8"), first);
});

test("a pointer the operator wrote themselves is left alone", () => {
  const root = newRoot();
  writeLessons(root);
  const path = vscodeLessonsViewPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const theirs = "See .tlc/harness/lessons.md, in my own words.\n";
  writeFileSync(path, theirs, "utf8");

  assert.equal(renderVSCodeLessonsView(root), path);
  assert.equal(readFileSync(path, "utf8"), theirs);
});
