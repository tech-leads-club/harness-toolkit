import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderCursorHooksDocument } from "../../../bin/write-user-hooks.mjs";
import { claudeWiring, mergeClaudeSettings } from "../claude/claude.wiring.ts";
import { cursorWiring } from "../cursor/cursor.wiring.ts";
import { providers } from "../provider.registry.ts";

const RUNTIME = { launcherPath: "/opt/tlc/bin/tlc-exec.mjs" };

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function golden(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

test("cursor wiring declares the cursor-hooks-json kind", () => {
  assert.equal(cursorWiring(RUNTIME).kind, "cursor-hooks-json");
});

test("claude wiring declares the claude-settings-json kind", () => {
  assert.equal(claudeWiring(RUNTIME).kind, "claude-settings-json");
});

/**
 * why: `strategy` is what the dispatchers used to branch on, and it cannot tell two formats apart. Asserting the
 * pair is distinct is what makes the discriminator load-bearing rather than decorative — an adapter that copies a
 * neighbour's kind fails here.
 */
test("every registered provider declares a kind, and no two providers share one", () => {
  const kinds = providers.map((provider) => provider.wiring(RUNTIME).kind);
  for (const kind of kinds) {
    assert.ok(typeof kind === "string" && kind.length > 0, "every provider declares a wiring kind");
  }
  assert.equal(new Set(kinds).size, kinds.length, `wiring kinds must be unique, got ${kinds.join(", ")}`);
});

/**
 * invariant: `kind` is a routing fact for the tooling, not part of the document a host reads. A host that started
 * seeing an unknown top-level key because of an internal refactor is the regression this pins.
 */
test("the emitted cursor hooks document is byte-identical to the one HEAD fce146c emitted", () => {
  const document = renderCursorHooksDocument(cursorWiring(RUNTIME).entries);
  assert.equal(`${JSON.stringify(document, null, 2)}\n`, golden("wiring-head-fce146c.cursor-hooks.json"));
});

test("the emitted claude settings document is byte-identical to the one HEAD fce146c emitted", () => {
  const merged = mergeClaudeSettings(null, claudeWiring(RUNTIME).entries);
  assert.ok(merged.ok);
  if (merged.ok) {
    assert.equal(`${merged.settingsText}\n`, golden("wiring-head-fce146c.claude-settings.json"));
  }
});

test("neither emitted document carries the kind discriminator", () => {
  const cursorText = JSON.stringify(renderCursorHooksDocument(cursorWiring(RUNTIME).entries));
  assert.equal(cursorText.includes("cursor-hooks-json"), false);
  const merged = mergeClaudeSettings(null, claudeWiring(RUNTIME).entries);
  assert.ok(merged.ok);
  if (merged.ok) {
    assert.equal(merged.settingsText.includes("claude-settings-json"), false);
  }
});
