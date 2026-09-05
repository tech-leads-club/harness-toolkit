import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCapabilities } from "../../claude/claude.capabilities.ts";
import { codexCapabilities } from "../../codex/codex.capabilities.ts";
import { cursorCapabilities } from "../../cursor/cursor.capabilities.ts";
import { vscodeCapabilities } from "../vscode.capabilities.ts";

const FIELD_COUNT = 15;

const vscode = vscodeCapabilities();

// spec P4 AC2: all 15 fields declared.
test("the descriptor declares all 15 fields", () => {
  assert.equal(Object.keys(vscode).length, FIELD_COUNT);
});

/** The whole table, asserted as one value against [/decisions/ad-125.md](/decisions/ad-125.md). */
test("every flag matches the value AD-125 cites", () => {
  assert.deepEqual(vscode, {
    enforcesHooks: true,
    askSupportedOn: ["shell.before", "mcp.before", "read.before", "tool.before"],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: false,
    toolOutputRewrite: false,
    contextAtToolBefore: false,
    contextAtToolAfter: false,
    contextAtStop: false,
    sessionStartContextReliable: true,
    toolOutputAtAfter: true,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  });
});

/**
 * spec P4 AC2, stated as its own assertion because the list is the load-bearing one: `PreToolUse` is the only
 * event whose hook may return `permissionDecision: "ask"`, and these four are exactly what it fans out to.
 */
test("askSupportedOn lists exactly the four before-kinds PreToolUse fans out to", () => {
  assert.deepEqual([...vscode.askSupportedOn].sort(), [
    "mcp.before",
    "read.before",
    "shell.before",
    "tool.before",
  ]);
});

// spec P4 AC2: toolOutputRewrite false, sessionStartContextReliable true, thoughtEvent false.
test("the three flags spec P4 AC2 names directly carry the values it names", () => {
  assert.equal(vscode.toolOutputRewrite, false);
  assert.equal(vscode.sessionStartContextReliable, true);
  assert.equal(vscode.thoughtEvent, false);
});

/**
 * AD-125 correction: the design carried `additionalContext` at before, after, and stop from the transcription.
 * The VS Code page documents it on `SessionStart` alone, so all three are false and `degrade()` strips a context
 * decision at those points before the renderer sees it (T17 depends on this).
 */
test("no context channel is claimed outside SessionStart", () => {
  assert.equal(vscode.contextAtToolBefore, false);
  assert.equal(vscode.contextAtToolAfter, false);
  assert.equal(vscode.contextAtStop, false);
});

test("no turn counter is claimed, because stop_hook_active is a boolean and the flag claims a count", () => {
  assert.equal(vscode.nativeLoopCounter, false);
});

/**
 * why: the failure this table exists to prevent is a value carried in from whichever host was handy. This host
 * reuses Claude's payload shape byte for byte, which makes Claude's descriptor the one most likely to be copied.
 */
test("the descriptor is none of Claude's, Cursor's, or Codex's", () => {
  assert.notDeepEqual(vscode, claudeCapabilities());
  assert.notDeepEqual(vscode, cursorCapabilities());
  assert.notDeepEqual(vscode, codexCapabilities());
});

/**
 * The copy-paste detector. A value carried over from Claude collapses this list, and a value invented here grows
 * it. `askSupportedOn` is compared as a set, because the two hosts list the same four kinds in a different order
 * and an ordering difference is not a capability difference.
 */
test("the six rows VS Code differs from Claude on are the six AD-125 settles against the VS Code page", () => {
  const claude = claudeCapabilities();
  const canonical = (value: unknown): string =>
    JSON.stringify(Array.isArray(value) ? [...value].sort() : value);
  const differing = (Object.keys(vscode) as (keyof typeof vscode)[])
    .filter((key) => canonical(vscode[key]) !== canonical(claude[key]))
    .sort();
  assert.deepEqual(differing, [
    "contextAtStop",
    "contextAtToolAfter",
    "contextAtToolBefore",
    "effortSignal",
    "toolInputRewrite",
    "toolOutputRewrite",
  ]);
});
