import assert from "node:assert/strict";
import { test } from "node:test";
import { claudePolicyDefaults } from "../../claude/claude.policy-defaults.ts";
import { cursorPolicyDefaults } from "../../cursor/cursor.policy-defaults.ts";
import { codexPolicyDefaults } from "../codex.policy-defaults.ts";

const defaults = codexPolicyDefaults();

test("codexPolicyDefaults marks the one web tool the transcription records for this host", () => {
  assert.deepEqual(defaults.untrustedTools, ["WebSearch"]);
});

// hazard: the two nearest hosts spell their fetch tools differently, and neither name is Codex's.
test("no other host's tool names are carried across", () => {
  assert.ok(!defaults.untrustedTools.includes("WebFetch"), "WebFetch is Claude's name");
  assert.ok(!defaults.untrustedTools.includes("Fetch"), "Fetch is Cursor's name");
  assert.notDeepEqual(defaults, claudePolicyDefaults());
  assert.notDeepEqual(defaults, cursorPolicyDefaults());
});

test("codexPolicyDefaults blocks no model pattern, because none is documented for this host", () => {
  assert.deepEqual(defaults.blockedPatterns, []);
});

test("codexPolicyDefaults sets no minimum effort", () => {
  assert.equal(defaults.minEffort, null);
});
