import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { renderProviderLessonsView } from "../../../entrypoints/support.ts";
import {
  applyOpencodeLessonsView,
  opencodeConfigFilePath,
  opencodeLessonsSourcePath,
} from "../opencode.lessons-view.ts";

const ENTRY = ".tlc/harness/lessons.md";

function projectWithLessons(): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-opencode-lessons-"));
  const source = opencodeLessonsSourcePath(root);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, "- always run the gate\n");
  return root;
}

function config(root: string): string {
  return readFileSync(opencodeConfigFilePath(root), "utf8");
}

test("creates opencode.json with the pointer when the project has none", () => {
  const root = projectWithLessons();
  const result = applyOpencodeLessonsView(root);
  assert.equal(result.status, "written");
  assert.deepEqual(JSON.parse(config(root)), { instructions: [ENTRY] });
});

test("appends to an existing instructions array and keeps every other key", () => {
  const root = projectWithLessons();
  writeFileSync(
    opencodeConfigFilePath(root),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", instructions: ["docs/rules.md"] }, null, 2)}\n`,
  );
  assert.equal(applyOpencodeLessonsView(root).status, "written");
  assert.deepEqual(JSON.parse(config(root)), {
    $schema: "https://opencode.ai/config.json",
    instructions: ["docs/rules.md", ENTRY],
  });
});

test("adds the array to a config that has none, without disturbing what is there", () => {
  const root = projectWithLessons();
  writeFileSync(opencodeConfigFilePath(root), `${JSON.stringify({ model: "anthropic/claude" }, null, 2)}\n`);
  assert.equal(applyOpencodeLessonsView(root).status, "written");
  assert.deepEqual(JSON.parse(config(root)), { model: "anthropic/claude", instructions: [ENTRY] });
});

// invariant: the second run leaves the file byte-identical to the first run's output.
test("running twice is idempotent, byte for byte", () => {
  const root = projectWithLessons();
  applyOpencodeLessonsView(root);
  const first = config(root);
  const second = applyOpencodeLessonsView(root);
  assert.equal(second.status, "unchanged");
  assert.equal(config(root), first);
});

test("an entry the operator added by hand is left alone rather than duplicated", () => {
  const root = projectWithLessons();
  const handwritten = `${JSON.stringify({ instructions: [ENTRY, "docs/rules.md"] }, null, 4)}\n`;
  writeFileSync(opencodeConfigFilePath(root), handwritten);
  assert.equal(applyOpencodeLessonsView(root).status, "unchanged");
  assert.equal(config(root), handwritten, "their formatting survives too");
});

/**
 * hazard: rewriting a config that does not parse breaks the operator's whole host, which is strictly worse than
 * missing lessons. The file is left byte-identical and the failure is reported.
 */
test("an unparseable opencode.json is left byte-identical and reported", () => {
  const root = projectWithLessons();
  const broken = "{ not valid json";
  writeFileSync(opencodeConfigFilePath(root), broken);
  const result = applyOpencodeLessonsView(root);
  assert.equal(result.status, "unparsed");
  assert.equal(config(root), broken);
});

test("a config that parses to an array or a scalar is treated the same way as broken", () => {
  for (const text of ["[1, 2, 3]", '"a string"', "null"]) {
    const root = projectWithLessons();
    writeFileSync(opencodeConfigFilePath(root), text);
    assert.equal(applyOpencodeLessonsView(root).status, "unparsed", text);
    assert.equal(config(root), text, text);
  }
});

test("no lessons file means no pointer — an empty one would be worse than none", () => {
  const root = mkdtempSync(join(tmpdir(), "tlc-opencode-lessons-"));
  assert.equal(applyOpencodeLessonsView(root).status, "absent");
  assert.equal(renderProviderLessonsView("opencode-legacy", root), null);
});

test("both generations dispatch to the same view, because they are one host and one config", () => {
  const root = projectWithLessons();
  const fromLegacy = renderProviderLessonsView("opencode-legacy", root);
  const fromNamespaced = renderProviderLessonsView("opencode-namespaced", root);
  assert.equal(fromLegacy, opencodeConfigFilePath(root));
  assert.equal(fromNamespaced, fromLegacy);
  assert.deepEqual(JSON.parse(config(root)).instructions, [ENTRY], "the second call added nothing");
});

test("an unknown provider name still dispatches to nothing", () => {
  const root = projectWithLessons();
  assert.equal(renderProviderLessonsView("opencode", root), null, "the bare host name is not an adapter");
});
