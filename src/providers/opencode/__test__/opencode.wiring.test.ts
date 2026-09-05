import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
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

/**
 * hazard: opencode's discovery glob is `{plugin,plugins}/*.{ts,js}` — flat, one level. A nested target is never
 * loaded at all, and two sibling targets are both loaded, which fires every hook twice.
 */
test("both generations name one flat file, so nothing is nested and nothing is loaded twice", () => {
  assert.equal(legacy.target, namespaced.target);
  assert.ok(legacy.target.endsWith("tlc-harness.js"), legacy.target);
  assert.equal(basename(dirname(legacy.target)), "plugins", legacy.target);
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
  assert.equal(legacyText, namespacedText, "one target may only ever hold one text");
  assert.ok(legacyText.includes("both pluginApi generations — legacy and namespaced"));
  assert.ok(!isOpencodeManaged("export const Mine = async () => ({});"));
  assert.equal(isOpencodeManaged(null), false);
});

test("the one module carries both register paths and picks between them at load time", () => {
  const text = renderOpencodePlugin(legacy) ?? "";

  assert.ok(text.includes('"tool.execute.before": async (input, output)'), "the legacy flat hook keys");
  assert.ok(text.includes('ctx.tool.hook("execute.before"'));
  assert.ok(text.includes('ctx.shell.hook("create.before"'));
  assert.ok(text.includes('ctx.permission.hook("evaluate"'));
  assert.ok(text.includes("isNamespacedHost(input)"), "the runtime selection between the two");
});

/**
 * hazard: `@opencode-ai/plugin` 1.17.9 has no runtime `Plugin` export — `dist/index.js` re-exports `tool` alone —
 * so importing one is a link-time error that takes the whole bridge down, on every install.
 */
test("the module imports nothing but node's own child_process", () => {
  const text = renderOpencodePlugin(legacy) ?? "";
  assert.deepEqual(
    [...text.matchAll(/^import .* from "(.+)";$/gm)].map((match) => match[1]),
    ["node:child_process"],
  );
});

/**
 * invariant: opencode's legacy plugin host iterates every export and throws on the first that is not a function.
 * A single exported constant would take the whole bridge down.
 */
test("the module exports exactly one thing, and it is a function", () => {
  const text = renderOpencodePlugin(legacy) ?? "";
  assert.deepEqual(
    [...text.matchAll(/^export .*$/gm)].map((match) => match[0]),
    ["export default async function TlcHarness(input) {"],
  );
});

test("each generation's hint routes to its own adapter, and the envelope carries its own stamp", () => {
  const text = renderOpencodePlugin(legacy) ?? "";
  const launcher = JSON.stringify(RUNTIME.launcherPath);
  assert.ok(text.includes(`"legacy": ["node",${launcher},"--provider","opencode-legacy"]`), text);
  assert.ok(text.includes(`"namespaced": ["node",${launcher},"--provider","opencode-namespaced"]`), text);
  // invariant: the stamp is `decide`'s own argument, so it is whichever generation actually called it.
  assert.ok(text.includes('provider: "opencode", pluginApi, hook, ...payload'));
  assert.ok(text.includes('decide("legacy", "tool.execute.before"'));
  assert.ok(text.includes('decide("namespaced", "permission.evaluate"'));
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
