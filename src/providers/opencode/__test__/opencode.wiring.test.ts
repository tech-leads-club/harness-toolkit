import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimePaths } from "../../../contracts/index.ts";
import {
  isOpencodeManaged,
  OPENCODE_MANAGED_MARKER,
  opencodeLegacyWiring,
  opencodeNamespacedWiring,
  renderOpencodePlugin,
} from "../opencode.wiring.ts";

const RUNTIME: RuntimePaths = { launcherPath: "/home/dev/.tlc/harness/bin/tlc-exec.mjs" };

const legacy = opencodeLegacyWiring(RUNTIME);
const namespaced = opencodeNamespacedWiring(RUNTIME);

test("each generation declares its own kind, and both replace the whole module", () => {
  assert.equal(legacy.kind, "opencode-plugin");
  assert.equal(namespaced.kind, "opencode-plugin-ns");
  assert.equal(legacy.strategy, "replace");
  assert.equal(namespaced.strategy, "replace");
});

test("the two targets are distinct files, so one generation never overwrites the other", () => {
  assert.notEqual(legacy.target, namespaced.target);
  assert.ok(legacy.target.endsWith("tlc-harness.js"), legacy.target);
  assert.ok(namespaced.target.endsWith(`tlc-harness${"/"}index.ts`), namespaced.target);
});

test("each module registers its generation's hooks and no others", () => {
  assert.deepEqual(
    legacy.entries.map((entry) => entry.hookEvent),
    ["tool.execute.before", "tool.execute.after"],
  );
  assert.deepEqual(
    namespaced.entries.map((entry) => entry.hookEvent),
    ["tool.execute.before", "tool.execute.after", "shell.create.before", "permission.evaluate"],
  );
});

// invariant: the hint is what routes a payload to one of two adapters that both answer to `provider: "opencode"`.
test("every entry launches with its own adapter name as the provider hint", () => {
  for (const entry of legacy.entries) {
    assert.deepEqual(entry.args.slice(0, 3), [RUNTIME.launcherPath, "--provider", "opencode-legacy"]);
    assert.equal(entry.args.at(-1), entry.handler);
  }
  for (const entry of namespaced.entries) {
    assert.deepEqual(entry.args.slice(0, 3), [RUNTIME.launcherPath, "--provider", "opencode-namespaced"]);
  }
});

test("every entry names a handler the launcher accepts", () => {
  for (const entry of [...legacy.entries, ...namespaced.entries]) {
    assert.ok(["tool-before", "tool-after"].includes(entry.handler), entry.handler);
  }
});

test("both emitted modules carry the managed marker and their own generation stamp", () => {
  const legacyText = renderOpencodePlugin(legacy) ?? "";
  const namespacedText = renderOpencodePlugin(namespaced) ?? "";
  assert.ok(isOpencodeManaged(legacyText));
  assert.ok(isOpencodeManaged(namespacedText));
  assert.ok(legacyText.includes(OPENCODE_MANAGED_MARKER));
  assert.ok(legacyText.includes("// pluginApi: legacy"));
  assert.ok(namespacedText.includes("// pluginApi: namespaced"));
  assert.ok(!isOpencodeManaged("export const Mine = async () => ({});"));
  assert.equal(isOpencodeManaged(null), false);
});

test("the legacy module registers flat hook keys, the namespaced one registers through ctx", () => {
  const legacyText = renderOpencodePlugin(legacy) ?? "";
  const namespacedText = renderOpencodePlugin(namespaced) ?? "";

  assert.ok(legacyText.includes('"tool.execute.before": async (input, output)'));
  assert.ok(!legacyText.includes("ctx."), "the legacy API has no plugin context to register through");
  assert.ok(!legacyText.includes("permission"), "the legacy API has no permission hook to register");
  assert.ok(!legacyText.includes("@opencode-ai/plugin"), "the legacy API has no SDK import");

  assert.ok(namespacedText.includes('import { Plugin } from "@opencode-ai/plugin";'));
  assert.ok(namespacedText.includes('ctx.tool.hook("execute.before"'));
  assert.ok(namespacedText.includes('ctx.shell.hook("create.before"'));
  assert.ok(namespacedText.includes('ctx.permission.hook("evaluate"'));
});

test("each module stamps the envelope its own detector matches on", () => {
  assert.ok((renderOpencodePlugin(legacy) ?? "").includes('pluginApi: "legacy"'));
  assert.ok((renderOpencodePlugin(namespaced) ?? "").includes('pluginApi: "namespaced"'));
});

test("no plugin text exists for a kind that is not opencode's", () => {
  assert.equal(renderOpencodePlugin({ ...legacy, kind: "cursor-hooks-json" }), null);
});

/**
 * why asserted rather than left to the writer: the module is generated from the wiring, so the launcher path
 * reaches the host only if it is baked into the text. A relative path here would break the moment the runtime
 * moved, which is the failure `TLC_HOME` exists to prevent everywhere else.
 */
test("the launcher path is written into both modules absolutely", () => {
  for (const wiring of [legacy, namespaced]) {
    assert.ok((renderOpencodePlugin(wiring) ?? "").includes(RUNTIME.launcherPath));
  }
});
