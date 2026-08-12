import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * why: the required field is the whole enforcement — making it optional again produces zero compiler errors, so
 * nothing else in the repository would catch a producer that forgot. What the type cannot catch is an empty or
 * duplicated rule name, which is what this asserts ([/decisions/ad-061.md](/decisions/ad-061.md)).
 */
test("every rule name a rail can produce is non-empty and belongs to one rail", async () => {
  const [{ SHELL_RULES }, { SUBAGENT_RULES }, { DEGRADE_RULES }, { FLOOR_RULE_IDS }] = await Promise.all([
    import("../../core/shell-policy/shell-policy.service.ts"),
    import("../../core/subagent-policy/subagent-policy.service.ts"),
    import("../../providers/provider.degrade.ts"),
    import("../../core/floor/floor.catalog.ts"),
  ]);
  const all = [
    ...Object.values(SHELL_RULES),
    ...Object.values(SUBAGENT_RULES),
    ...Object.values(DEGRADE_RULES),
    ...FLOOR_RULE_IDS,
  ];
  for (const rule of all) {
    assert.equal(typeof rule, "string");
    assert.ok(rule.trim().length > 0, "a rule with no name attributes nothing");
    // invariant: kebab-case, because these appear in `rule=…` in messages operators read and in obs attributes
    assert.match(rule, /^[a-z][a-z0-9-]*$/, rule);
  }
  assert.equal(new Set(all).size, all.length, "two rails claiming one rule name makes the report ambiguous");
});
