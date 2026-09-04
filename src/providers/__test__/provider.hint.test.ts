import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort } from "../provider.port.ts";
import { providers, resolveByHint, resolveFromRegistry } from "../provider.registry.ts";

/**
 * why a detector that throws rather than a counter: a spy proves how often detect ran, and this needs to prove it
 * never ran at all. A throw makes the difference a failure instead of an assertion someone can weaken later.
 */
function explodingProvider(name: string): ProviderPort {
  return {
    name,
    detect(): boolean {
      throw new Error(`detect must not run when a hint is set (${name})`);
    },
    capabilities() {
      throw new Error("not used");
    },
    policyDefaults() {
      throw new Error("not used");
    },
    toEvent() {
      return null;
    },
    render() {
      return { stdout: null, exitCode: 0 };
    },
    wiring() {
      return { target: "/tmp/fixture.json", kind: "cursor-hooks-json", strategy: "replace", entries: [] };
    },
  };
}

test("a hint resolves by name without running any detector", () => {
  const registry = [explodingProvider("alpha"), explodingProvider("beta")];
  const result = resolveByHint("beta", registry);
  assert.equal(result.provider?.name, "beta");
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.matchedNames, ["beta"]);
});

test("a hint naming no registered provider resolves to nothing, and still runs no detector", () => {
  const registry = [explodingProvider("alpha")];
  const result = resolveByHint("nobody", registry);
  assert.equal(result.provider, null);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.matchedNames, []);
});

// hazard: a prefix or case-insensitive match would let one host's wiring claim another's adapter. The name is the
// address; near enough is not enough.
test("hint matching is exact — not a prefix, not case-insensitive", () => {
  const registry = [explodingProvider("cursor")];
  assert.equal(resolveByHint("curs", registry).provider, null);
  assert.equal(resolveByHint("Cursor", registry).provider, null);
  assert.equal(resolveByHint("cursor2", registry).provider, null);
  assert.equal(resolveByHint("cursor", registry).provider?.name, "cursor");
});

test("an empty hint resolves to nothing rather than to the first provider", () => {
  assert.equal(resolveByHint("", providers).provider, null);
});

/**
 * The case the hint exists for: a payload that content detection would award to another provider still resolves to
 * the hinted one. Every registered provider is reachable by name, so a later host cannot be addressable in the
 * registry and unreachable by hint.
 */
test("every registered provider is reachable by its own name", () => {
  for (const provider of providers) {
    assert.equal(resolveByHint(provider.name, providers).provider?.name, provider.name);
  }
});

test("a hinted payload resolves to the hinted provider even when another provider's detector claims it", () => {
  const claudeShaped = { hook_event_name: "SessionStart", cwd: "/repo" };
  const detected = resolveFromRegistry(claudeShaped, providers);
  assert.equal(detected.provider?.name, "claude", "precondition: content detection awards this to claude");

  const hinted = resolveByHint("cursor", providers);
  assert.equal(hinted.provider?.name, "cursor");
});
