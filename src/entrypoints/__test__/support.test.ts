import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessEvent } from "../../contracts/index.ts";
import { shaScopeRoot } from "../support.ts";

const BASE_EVENT: HarnessEvent = {
  provider: "claude",
  event: "shell.before",
  sessionKey: "claude-probe",
  projectDir: "/main-checkout",
  raw: {},
};

// why: this precedence is the entire AD-114 fix — `event.cwd` is the field the host actually moves
// into a worktree, `event.projectDir` is the one that deliberately does not.
test("shaScopeRoot prefers event.cwd over event.projectDir when both are present", () => {
  const event: HarnessEvent = { ...BASE_EVENT, cwd: "/main-checkout/.claude/worktrees/feature-x" };
  assert.equal(shaScopeRoot(event), "/main-checkout/.claude/worktrees/feature-x");
});

test("shaScopeRoot falls back to event.projectDir when cwd is absent", () => {
  assert.equal(shaScopeRoot(BASE_EVENT), "/main-checkout");
});

test("shaScopeRoot returns projectDir unchanged when cwd equals it", () => {
  const event: HarnessEvent = { ...BASE_EVENT, cwd: "/main-checkout" };
  assert.equal(shaScopeRoot(event), "/main-checkout");
});
