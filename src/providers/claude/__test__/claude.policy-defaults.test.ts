import assert from "node:assert/strict";
import { test } from "node:test";
import { claudePolicyDefaults } from "../claude.policy-defaults.ts";

/**
 * hazard: this adapter shipped `["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]`, and an empty
 * project list fell back to it — so `claude-sonnet-5-thinking-high` was refused by a list nobody in the project had
 * written, and the refusal named no source ([/decisions/ad-053.md](/decisions/ad-053.md)).
 */
test("claudePolicyDefaults ships no model allowlist — the operator chooses", () => {
  assert.ok(!("allowedModels" in claudePolicyDefaults()));
});

test("claudePolicyDefaults has no blocked model-name patterns — the quality axis is effort, not a model suffix", () => {
  assert.deepEqual(claudePolicyDefaults().blockedPatterns, []);
});

test("claudePolicyDefaults sets no minimum effort by default", () => {
  assert.equal(claudePolicyDefaults().minEffort, null);
});
