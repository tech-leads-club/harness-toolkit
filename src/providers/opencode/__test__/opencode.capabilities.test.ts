import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderCapabilities } from "../../../contracts/index.ts";
import { HARNESS_EVENT_KINDS } from "../../../contracts/index.ts";
import { claudeCapabilities } from "../../claude/claude.capabilities.ts";
import { cursorCapabilities } from "../../cursor/cursor.capabilities.ts";
import { opencodeLegacyCapabilities, opencodeNamespacedCapabilities } from "../opencode.capabilities.ts";

const FIELD_COUNT = 15;

const legacy = opencodeLegacyCapabilities();
const namespaced = opencodeNamespacedCapabilities();

test("both descriptors declare all 15 fields", () => {
  assert.equal(Object.keys(legacy).length, FIELD_COUNT);
  assert.equal(Object.keys(namespaced).length, FIELD_COUNT);
  assert.deepEqual(Object.keys(legacy).sort(), Object.keys(namespaced).sort());
});

test("the legacy API has no ask channel and no shell hook", () => {
  assert.deepEqual(legacy.askSupportedOn, []);
  assert.equal(legacy.dedicatedShellEvent, false);
});

test("the namespaced API declares ask and a dedicated shell event", () => {
  assert.ok(namespaced.askSupportedOn.length > 0);
  assert.equal(namespaced.dedicatedShellEvent, true);
});

test("every ask kind is a real HarnessEventKind and is a before-kind", () => {
  for (const kind of namespaced.askSupportedOn) {
    assert.ok(HARNESS_EVENT_KINDS.includes(kind), kind);
    assert.ok(kind.endsWith(".before"), kind);
  }
});

/**
 * invariant: this is the copy-paste detector. The two generations disagree on six rows, and which six is the
 * whole argument for registering opencode twice ([/decisions/ad-124.md](/decisions/ad-124.md)). A descriptor
 * copied from its sibling collapses this list and fails here.
 */
const EXPECTED_DIVERGENCE: readonly (keyof ProviderCapabilities)[] = [
  "askSupportedOn",
  "contextAtToolAfter",
  "contextAtToolBefore",
  "dedicatedShellEvent",
  "toolInputRewrite",
  "toolOutputAtAfter",
];

function divergingFields(a: ProviderCapabilities, b: ProviderCapabilities): (keyof ProviderCapabilities)[] {
  const keys = Object.keys(a) as (keyof ProviderCapabilities)[];
  return keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
}

test("the two descriptors differ on exactly the six documented rows and agree on the other nine", () => {
  assert.deepEqual(divergingFields(legacy, namespaced), [...EXPECTED_DIVERGENCE]);
});

test("the rows the spec pins are the same on both generations", () => {
  for (const descriptor of [legacy, namespaced]) {
    assert.equal(descriptor.enforcesHooks, true);
    assert.equal(descriptor.toolOutputRewrite, true);
    assert.equal(descriptor.sessionStartContextReliable, false);
    assert.equal(descriptor.thoughtEvent, false);
  }
});

/**
 * why: the failure this table exists to prevent is a value carried in from a host that happens to be handy. The
 * two nearest are the two already registered, and both differ from either opencode descriptor.
 */
test("neither descriptor is Cursor's or Claude's", () => {
  for (const descriptor of [legacy, namespaced]) {
    assert.notDeepEqual(descriptor, cursorCapabilities());
    assert.notDeepEqual(descriptor, claudeCapabilities());
  }
});

test("neither generation claims a turn counter, since no opencode payload carries one", () => {
  assert.equal(legacy.nativeLoopCounter, false);
  assert.equal(namespaced.nativeLoopCounter, false);
});

test("neither generation claims usage, effort, a stop context channel, or session environment", () => {
  for (const descriptor of [legacy, namespaced]) {
    assert.equal(descriptor.usageInPayload, false);
    assert.equal(descriptor.effortSignal, false);
    assert.equal(descriptor.contextAtStop, false);
    assert.equal(descriptor.sessionEnv, false);
  }
});
