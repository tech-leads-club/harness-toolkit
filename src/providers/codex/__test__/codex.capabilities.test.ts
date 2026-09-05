import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCapabilities } from "../../claude/claude.capabilities.ts";
import { cursorCapabilities } from "../../cursor/cursor.capabilities.ts";
import { codexCapabilities } from "../codex.capabilities.ts";

const FIELD_COUNT = 15;

const codex = codexCapabilities();

test("the descriptor declares all 15 fields", () => {
  assert.equal(Object.keys(codex).length, FIELD_COUNT);
});

/**
 * The whole table, asserted as one value against
 * [/decisions/ad-123.md](/decisions/ad-123.md) — including its two corrections, which is why
 * `nativeLoopCounter` is false here and true in the record's first draft.
 */
test("every flag matches the value AD-123 cites", () => {
  assert.deepEqual(codex, {
    enforcesHooks: true,
    askSupportedOn: [],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: true,
    toolOutputRewrite: false,
    contextAtToolBefore: true,
    contextAtToolAfter: true,
    contextAtStop: false,
    sessionStartContextReliable: true,
    toolOutputAtAfter: true,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  });
});

/**
 * invariant: empty, and empty for a stated reason. Codex parses `permissionDecision: "ask"` and runs the tool
 * anyway, so a non-empty list here would turn every escalation into an approval with no error to notice.
 * `degrade()` renders an ask rule as a deny for this host instead.
 */
test("askSupportedOn is empty, because Codex parses ask and runs the tool anyway", () => {
  assert.deepEqual(codex.askSupportedOn, []);
});

test("no turn counter is claimed, because stop_hook_active is a boolean and the flag claims a count", () => {
  assert.equal(codex.nativeLoopCounter, false);
});

test("no shell event is claimed, because shell is PreToolUse with a matcher", () => {
  assert.equal(codex.dedicatedShellEvent, false);
});

/**
 * why: the failure this table exists to prevent is a value carried in from whichever host was handy. Codex's shape
 * is Claude's, which makes Claude's descriptor the one most likely to be copied.
 */
test("the descriptor is neither Claude's nor Cursor's", () => {
  assert.notDeepEqual(codex, claudeCapabilities());
  assert.notDeepEqual(codex, cursorCapabilities());
});

test("the four rows Codex differs from Claude on are the four the reference settles", () => {
  const claude = claudeCapabilities();
  const differing = (Object.keys(codex) as (keyof typeof codex)[])
    .filter((key) => JSON.stringify(codex[key]) !== JSON.stringify(claude[key]))
    .sort();
  assert.deepEqual(differing, ["askSupportedOn", "contextAtStop", "effortSignal", "toolOutputRewrite"]);
});
