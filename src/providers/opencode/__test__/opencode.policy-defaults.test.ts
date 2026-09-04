import assert from "node:assert/strict";
import { test } from "node:test";
import { opencodePolicyDefaults } from "../opencode.policy-defaults.ts";

// hazard: an empty project list used to fall back to an adapter-shipped catalog, so a spawn could be refused by a
// list nobody wrote ([/decisions/ad-053.md](/decisions/ad-053.md)).
test("opencodePolicyDefaults ships no model allowlist — the operator chooses", () => {
  assert.ok(!("allowedModels" in opencodePolicyDefaults()));
});

test("opencodePolicyDefaults marks opencode's own two web tools untrusted", () => {
  assert.deepEqual(opencodePolicyDefaults().untrustedTools, ["webfetch", "websearch"]);
});

// why: opencode names its tools in lower case. Claude's `WebFetch` or Cursor's `Fetch` here would match nothing
// and the rail would go quiet with no error ([/decisions/ad-124.md](/decisions/ad-124.md)).
test("the untrusted tool names are opencode's lower-case spellings, not another host's", () => {
  for (const tool of opencodePolicyDefaults().untrustedTools) {
    assert.equal(tool, tool.toLowerCase());
  }
});

test("opencodePolicyDefaults blocks no model pattern, because none is documented for this host", () => {
  assert.deepEqual(opencodePolicyDefaults().blockedPatterns, []);
});

test("opencodePolicyDefaults sets no minimum effort", () => {
  assert.equal(opencodePolicyDefaults().minEffort, null);
});
