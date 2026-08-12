import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_SCOPED_ENV } from "../../../tools/test-env.names.mjs";
import { PROJECT_SCOPED_ENV_NAMES, setProjectScopedEnv } from "../env-scope.ts";

test("only the names that are set and non-empty come back, in declaration order", () => {
  assert.deepEqual(setProjectScopedEnv({}), []);
  assert.deepEqual(setProjectScopedEnv({ CURSOR_PROJECT_DIR: "  " }), []);
  const all = Object.fromEntries(PROJECT_SCOPED_ENV_NAMES.map((name) => [name, "/x"]));
  assert.deepEqual(setProjectScopedEnv(all), [...PROJECT_SCOPED_ENV_NAMES]);
  assert.deepEqual(setProjectScopedEnv({ TLC_PROJECT_DIR: "/x" }), ["TLC_PROJECT_DIR"]);
});

// invariant: TLC_HOME names which runtime, not which project, and CI sets it deliberately. Recording it here
// would make every CI gate report an environment finding.
test("the runtime home is not a project-scoping variable", () => {
  assert.equal(PROJECT_SCOPED_ENV_NAMES.includes("TLC_HOME" as never), false);
});

/**
 * hazard: the hermetic test loader is a `.mjs` module read by `node --import` and cannot import the TypeScript
 * list, so the two are separate declarations of one fact. `CURSOR_PROJECT_DIR` was already missing from one of
 * them once. Agreement is asserted because it cannot be shared.
 */
test("the hermetic test loader neutralises exactly the variables the gate records", () => {
  assert.deepEqual([...PROJECT_SCOPED_ENV].sort(), [...PROJECT_SCOPED_ENV_NAMES].sort());
});
