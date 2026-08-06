import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorPolicyDefaults } from "../cursor.policy-defaults.ts";

// hazard: this adapter shipped a five-model catalog that an empty project list fell back to, so a spawn could be
// refused by a list nobody wrote ([/decisions/ad-053.md](/decisions/ad-053.md)).
test("cursorPolicyDefaults ships no model allowlist — the operator chooses", () => {
  assert.ok(!("allowedModels" in cursorPolicyDefaults()));
});

// invariant: the blocklist stays. It is concatenated with the project's rather than replacing it, and what it
// carries is the `-fast` denial this rail exists for.
test("cursorPolicyDefaults still ships the -fast blocklist", () => {
  assert.ok(cursorPolicyDefaults().blockedPatterns.length > 0);
});

test("cursorPolicyDefaults blocks -fast and /fast suffixes plus the composer-2.5-fast literal", () => {
  const defaults = cursorPolicyDefaults();
  assert.deepEqual(defaults.blockedPatterns, [
    "-fast(?:$|[^a-z0-9])",
    "/fast(?:$|[^a-z0-9])",
    "composer-2\\.5-fast",
  ]);
});

test("cursorPolicyDefaults sets no minimum effort", () => {
  assert.equal(cursorPolicyDefaults().minEffort, null);
});
