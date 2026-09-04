import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProviderCapabilities, ProviderPolicyDefaults } from "../../../contracts/index.ts";
import type { ProviderPort } from "../../provider.port.ts";
import { resolveFromRegistry } from "../../provider.registry.ts";
import { detectOpencodeLegacy, detectOpencodeNamespaced } from "../opencode.detect.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const PROVIDERS_DIR = join(HERE, "..", "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function fixturesIn(...segments: string[]): { name: string; payload: Record<string, unknown> }[] {
  const dir = join(...segments);
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => ({ name: entry, payload: readJson(join(dir, entry)) }));
}

const legacyFixtures = fixturesIn(FIXTURES_DIR, "legacy");
const namespacedFixtures = fixturesIn(FIXTURES_DIR, "namespaced");

/** why: the other hosts' fixtures are the collision set — VS Code and Codex both emit Claude's payload shape. */
const foreignFixtures = [
  ...fixturesIn(PROVIDERS_DIR, "codex", "__test__", "fixtures"),
  ...fixturesIn(PROVIDERS_DIR, "vscode", "__test__", "fixtures"),
  ...fixturesIn(PROVIDERS_DIR, "cursor", "__test__", "fixtures"),
  ...fixturesIn(PROVIDERS_DIR, "claude", "__test__", "fixtures"),
];

test("both fixture directories are non-empty, so the sweeps below assert something", () => {
  assert.ok(legacyFixtures.length > 0);
  assert.ok(namespacedFixtures.length > 0);
  assert.ok(foreignFixtures.length > 0);
});

test("the legacy detector claims every legacy fixture", () => {
  for (const { name, payload } of legacyFixtures) {
    assert.equal(detectOpencodeLegacy(payload), true, name);
  }
});

test("the namespaced detector claims every namespaced fixture", () => {
  for (const { name, payload } of namespacedFixtures) {
    assert.equal(detectOpencodeNamespaced(payload), true, name);
  }
});

test("neither detector claims the other generation's fixtures", () => {
  for (const { name, payload } of legacyFixtures) {
    assert.equal(detectOpencodeNamespaced(payload), false, name);
  }
  for (const { name, payload } of namespacedFixtures) {
    assert.equal(detectOpencodeLegacy(payload), false, name);
  }
});

test("neither detector claims another host's fixture", () => {
  for (const { name, payload } of foreignFixtures) {
    assert.equal(detectOpencodeLegacy(payload), false, name);
    assert.equal(detectOpencodeNamespaced(payload), false, name);
  }
});

test("the marker alone is not enough — an envelope with no generation is claimed by neither", () => {
  const unstamped = { provider: "opencode", hook: "tool.execute.before", sessionID: "ses_1" };
  assert.equal(detectOpencodeLegacy(unstamped), false);
  assert.equal(detectOpencodeNamespaced(unstamped), false);
});

test("the generation alone is not enough — a foreign payload carrying pluginApi is claimed by neither", () => {
  const imposter = { provider: "somethingelse", pluginApi: "legacy" };
  assert.equal(detectOpencodeLegacy(imposter), false);
  assert.equal(detectOpencodeNamespaced(imposter), false);
});

test("an unknown generation marker is claimed by neither, so a newer bridge fails visibly", () => {
  const future = { provider: "opencode", pluginApi: "v3", hook: "tool.execute.before" };
  assert.equal(detectOpencodeLegacy(future), false);
  assert.equal(detectOpencodeNamespaced(future), false);
});

test("non-objects are rejected rather than thrown on", () => {
  for (const raw of [null, undefined, 0, "opencode", true, [], [{ provider: "opencode" }]]) {
    assert.equal(detectOpencodeLegacy(raw), false, JSON.stringify(raw ?? null));
    assert.equal(detectOpencodeNamespaced(raw), false, JSON.stringify(raw ?? null));
  }
});

/**
 * invariant: both adapters are registered at once, so a payload either generation could claim would resolve as
 * `ambiguous` and no hook would run. This is the test that fails if a later edit widens either detector.
 */
function stubPort(name: string, detect: (raw: unknown) => boolean): ProviderPort {
  return {
    name,
    detect,
    capabilities: () => ({}) as ProviderCapabilities,
    policyDefaults: () => ({}) as ProviderPolicyDefaults,
    toEvent: () => null,
    render: () => ({ stdout: null, exitCode: 0 }),
    wiring: () => ({ target: "/tmp/x", kind: "cursor-hooks-json", strategy: "replace", entries: [] }),
  };
}

test("with both generations registered, no opencode payload resolves as ambiguous", () => {
  const registry = [
    stubPort("opencode-legacy", detectOpencodeLegacy),
    stubPort("opencode-namespaced", detectOpencodeNamespaced),
  ];
  for (const { name, payload } of [...legacyFixtures, ...namespacedFixtures]) {
    const result = resolveFromRegistry(payload, registry);
    assert.equal(result.ambiguous, false, name);
    assert.equal(result.matchedNames.length, 1, name);
  }
});

test("the expected generation wins for each fixture directory", () => {
  const registry = [
    stubPort("opencode-legacy", detectOpencodeLegacy),
    stubPort("opencode-namespaced", detectOpencodeNamespaced),
  ];
  for (const { name, payload } of legacyFixtures) {
    assert.equal(resolveFromRegistry(payload, registry).provider?.name, "opencode-legacy", name);
  }
  for (const { name, payload } of namespacedFixtures) {
    assert.equal(resolveFromRegistry(payload, registry).provider?.name, "opencode-namespaced", name);
  }
});
