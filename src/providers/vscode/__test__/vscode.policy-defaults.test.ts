import assert from "node:assert/strict";
import { test } from "node:test";
import { claudePolicyDefaults } from "../../claude/claude.policy-defaults.ts";
import { codexPolicyDefaults } from "../../codex/codex.policy-defaults.ts";
import { cursorPolicyDefaults } from "../../cursor/cursor.policy-defaults.ts";
import { vscodePolicyDefaults } from "../vscode.policy-defaults.ts";

const defaults = vscodePolicyDefaults();

/**
 * PROV-27's conservative-value rule applied to a list rather than a flag: neither source names a web tool in the
 * VS Code vocabulary, so nothing is listed. A name invented here would match no tool and the rail would look
 * configured while gating nothing.
 */
test("vscodePolicyDefaults names no untrusted tool, because neither source names one for this host", () => {
  assert.deepEqual(defaults.untrustedTools, []);
});

// hazard: three neighbouring hosts spell their web tools differently, and none of those names is VS Code's.
test("no other host's tool names are carried across", () => {
  assert.notDeepEqual(defaults, claudePolicyDefaults());
  assert.notDeepEqual(defaults, cursorPolicyDefaults());
  assert.notDeepEqual(defaults, codexPolicyDefaults());
});

test("vscodePolicyDefaults blocks no model pattern, because none is documented for this host", () => {
  assert.deepEqual(defaults.blockedPatterns, []);
});

test("vscodePolicyDefaults sets no minimum effort", () => {
  assert.equal(defaults.minEffort, null);
});
