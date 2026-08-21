import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shadowedKeys } from "../policy.shadow.ts";

/**
 * The layers are `DEFAULTS < user < project`, so a project key naming the value the lower tiers already resolve to
 * changes nothing today and stops tracking them for ever ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
describe("shadowedKeys", () => {
  test("a key that decides something is not reported", () => {
    assert.deepEqual(shadowedKeys({ mode: "focus" }, { mode: "solo" }), []);
  });

  test("a key that restates the tier below it is reported with its value", () => {
    assert.deepEqual(shadowedKeys({ mode: "solo" }, { mode: "solo" }), [{ path: "mode", value: "solo" }]);
  });

  /** invariant: the path is dotted, because that is how an operator finds it in the file. */
  test("nesting is reported by path, not by the leaf name alone", () => {
    const found = shadowedKeys(
      { intelligence: { lessons: { maxCharsSession: 900, maxInjectSession: 7 } } },
      { intelligence: { lessons: { maxCharsSession: 900, maxInjectSession: 5 } } },
    );

    assert.deepEqual(found, [{ path: "intelligence.lessons.maxCharsSession", value: 900 }]);
  });

  /** why an array compares by value: `codePaths: ["src"]` restates `codePaths: ["src"]`, reference or not. */
  test("an array that restates the tier below is reported", () => {
    assert.deepEqual(shadowedKeys({ codePaths: ["src", "tools"] }, { codePaths: ["src", "tools"] }), [
      { path: "codePaths", value: ["src", "tools"] },
    ]);
  });

  test("an array in a different order is a decision, not a restatement", () => {
    assert.deepEqual(shadowedKeys({ codePaths: ["tools", "src"] }, { codePaths: ["src", "tools"] }), []);
  });

  /** why `version` is skipped: it marks the config's shape rather than a setting, so naming it is required. */
  test("version is never reported", () => {
    assert.deepEqual(shadowedKeys({ version: 1 }, { version: 1 }), []);
  });

  test("a nested key named version is still a setting", () => {
    assert.deepEqual(shadowedKeys({ docs: { version: 1 } }, { docs: { version: 1 } }), [
      { path: "docs.version", value: 1 },
    ]);
  });

  test("a key the lower tiers do not carry at all is a decision", () => {
    assert.deepEqual(shadowedKeys({ rules: { enabled: true } }, {}), []);
  });

  /** hazard: `undefined === undefined` would make every absent key read as a restatement of nothing. */
  test("a key set to undefined on both sides is not invented as a finding", () => {
    assert.deepEqual(shadowedKeys({ mode: undefined }, {}), [{ path: "mode", value: undefined }]);
  });

  test("an object on one side and a scalar on the other is a decision", () => {
    assert.deepEqual(shadowedKeys({ grind: { enabled: true } }, { grind: true }), []);
  });

  test("every leaf of a fully restated block is named", () => {
    const block = { enabled: true, mode: "declared", onViolation: "followup" };

    assert.deepEqual(
      shadowedKeys({ comments: block }, { comments: { ...block } }).map((key) => key.path),
      ["comments.enabled", "comments.mode", "comments.onViolation"],
    );
  });
});
