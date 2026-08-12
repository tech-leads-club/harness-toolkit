import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Decision, HarnessEvent } from "../../../contracts/index.ts";
import { degrade } from "../../provider.degrade.ts";
import { claudeCapabilities } from "../claude.capabilities.ts";
import { claudeRender } from "../claude.outbound.ts";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

function golden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.json`), "utf8");
}

const TOOL_BEFORE_EVENT: HarnessEvent = {
  provider: "claude",
  event: "tool.before",
  sessionKey: "claude-contract-probe",
  projectDir: "/tmp",
  raw: {},
};

const SESSION_START_EVENT: HarnessEvent = { ...TOOL_BEFORE_EVENT, event: "session.start" };
const STOP_EVENT: HarnessEvent = { ...TOOL_BEFORE_EVENT, event: "stop" };

test("allow renders hookSpecificOutput.permissionDecision:allow with hookEventName PreToolUse", () => {
  const rendered = claudeRender({ kind: "allow" }, TOOL_BEFORE_EVENT);
  assert.equal(rendered.stdout, golden("allow"));
  assert.equal(rendered.exitCode, 0);
});

test("allow never includes permissionDecisionReason", () => {
  const rendered = claudeRender({ kind: "allow" }, TOOL_BEFORE_EVENT);
  assert.ok(rendered.stdout && !rendered.stdout.includes("permissionDecisionReason"));
});

test("deny renders hookSpecificOutput.permissionDecision:deny with permissionDecisionReason", () => {
  const decision: Decision = { kind: "deny", reason: "blocked pattern hit: -fast", rule: "test-deny" };
  const rendered = claudeRender(decision, TOOL_BEFORE_EVENT);
  assert.equal(rendered.stdout, golden("deny"));
  assert.equal(rendered.exitCode, 0);
});

test("ask renders hookSpecificOutput.permissionDecision:ask with permissionDecisionReason", () => {
  const decision: Decision = {
    kind: "ask",
    reason: "confirm before running this catastrophic command",
    rule: "test-ask",
  };
  const rendered = claudeRender(decision, TOOL_BEFORE_EVENT);
  assert.equal(rendered.stdout, golden("ask"));
  assert.equal(rendered.exitCode, 0);
});

test("abstain produces no stdout", () => {
  const rendered = claudeRender({ kind: "abstain" }, TOOL_BEFORE_EVENT);
  assert.equal(rendered.stdout, null);
  assert.equal(rendered.exitCode, 0);
});

test("context at session.start renders hookSpecificOutput.additionalContext with no env key", () => {
  const decision: Decision = {
    kind: "context",
    text: "Welcome back — 2 lessons pending review.",
  };
  const rendered = claudeRender(decision, SESSION_START_EVENT);
  assert.equal(rendered.stdout, golden("context"));
  assert.ok(rendered.stdout && !rendered.stdout.includes('"env"'));
});

test("context never emits an env key even when the decision carries one", () => {
  const decision: Decision = { kind: "context", text: "hello", env: { FOO: "bar" } };
  const rendered = claudeRender(decision, SESSION_START_EVENT);
  assert.ok(rendered.stdout && !rendered.stdout.includes('"env"'));
  assert.ok(rendered.stdout.includes('"additionalContext":"hello"'));
});

test("continue renders {decision:block,reason:...} with no hookSpecificOutput wrapper", () => {
  const decision: Decision = {
    kind: "continue",
    text: "Run the lint fixer, then re-run until the gate passes.",
  };
  const rendered = claudeRender(decision, STOP_EVENT);
  assert.equal(rendered.stdout, golden("continue"));
  assert.ok(rendered.stdout && !rendered.stdout.includes("hookSpecificOutput"));
});

test("rewriteInput renders hookSpecificOutput.updatedInput", () => {
  const decision: Decision = {
    kind: "rewriteInput",
    input: { command: "ls -la ./safe-dir" },
    reason: "scoped to a safe directory",
  };
  const rendered = claudeRender(decision, TOOL_BEFORE_EVENT);
  assert.equal(rendered.stdout, golden("rewrite-input"));
});

test("rewriteInput never leaks the reason field into rendered output", () => {
  const rendered = claudeRender(
    { kind: "rewriteInput", input: { x: 1 }, reason: "should not appear" },
    TOOL_BEFORE_EVENT,
  );
  assert.ok(rendered.stdout && !rendered.stdout.includes("should not appear"));
});

test("hookEventName reflects the originating event for every fanned-out kind", () => {
  const cases: Array<[HarnessEvent["event"], string]> = [
    ["shell.before", "PreToolUse"],
    ["mcp.before", "PreToolUse"],
    ["read.before", "PreToolUse"],
    ["tool.after", "PostToolUse"],
    ["shell.after", "PostToolUse"],
    ["edit.after", "PostToolUse"],
    ["tool.failure", "PostToolUseFailure"],
    ["subagent.start", "SubagentStart"],
    ["subagent.stop", "SubagentStop"],
    ["stop", "Stop"],
    ["compact.before", "PreCompact"],
    ["response.after", "MessageDisplay"],
    ["session.end", "SessionEnd"],
    ["prompt.submit", "UserPromptSubmit"],
  ];
  for (const [event, hookEventName] of cases) {
    const rendered = claudeRender({ kind: "allow" }, { ...TOOL_BEFORE_EVENT, event });
    assert.ok(rendered.stdout, event);
    assert.equal(JSON.parse(rendered.stdout).hookSpecificOutput.hookEventName, hookEventName, event);
  }
});

test("every decision kind renders with exit code 0 — exit code 2 is never produced", () => {
  const decisions: Decision[] = [
    { kind: "abstain" },
    { kind: "allow" },
    { kind: "deny", reason: "r", rule: "test-deny" },
    { kind: "ask", reason: "r", rule: "test-ask" },
    { kind: "context", text: "t" },
    { kind: "continue", text: "t" },
    { kind: "rewriteInput", input: {}, reason: "r" },
  ];
  for (const decision of decisions) {
    const rendered = claudeRender(decision, TOOL_BEFORE_EVENT);
    assert.equal(rendered.exitCode, 0, decision.kind);
    assert.notEqual(rendered.exitCode, 2, decision.kind);
  }
});

test("render output depends only on event.event, not on sessionKey or projectDir", () => {
  const otherEvent: HarnessEvent = {
    ...TOOL_BEFORE_EVENT,
    sessionKey: "claude-other",
    projectDir: "/elsewhere",
  };
  const decision: Decision = { kind: "allow" };
  assert.equal(claudeRender(decision, TOOL_BEFORE_EVENT).stdout, claudeRender(decision, otherEvent).stdout);
});

test("context text with embedded quotes and newlines round-trips through JSON escaping", () => {
  const text = 'line one\nline "two" with quotes\tand a tab';
  const rendered = claudeRender({ kind: "context", text }, SESSION_START_EVENT);
  assert.ok(rendered.stdout);
  const parsed = JSON.parse(rendered.stdout as string);
  assert.equal(parsed.hookSpecificOutput.additionalContext, text);
});

test("ask at a kind outside askSupportedOn is degraded to deny before it ever reaches the renderer", () => {
  const toolAfterEvent: HarnessEvent = { ...TOOL_BEFORE_EVENT, event: "tool.after" };
  const askDecision: Decision = { kind: "ask", reason: "confirm deletion", rule: "test-ask" };
  const degraded = degrade(askDecision, toolAfterEvent, claudeCapabilities());
  assert.equal(degraded.kind, "deny");
  const rendered = claudeRender(degraded, toolAfterEvent);
  assert.ok(rendered.stdout);
  assert.equal(JSON.parse(rendered.stdout as string).hookSpecificOutput.permissionDecision, "deny");
});

test("context at tool.before uses hookEventName PreToolUse, not a hardcoded SessionStart", () => {
  const decision: Decision = { kind: "context", text: "advisory note" };
  const rendered = claudeRender(decision, TOOL_BEFORE_EVENT);
  assert.ok(rendered.stdout);
  assert.equal(JSON.parse(rendered.stdout as string).hookSpecificOutput.hookEventName, "PreToolUse");
});

test("ask on a kind inside askSupportedOn (read.before) passes through unchanged", () => {
  const readBeforeEvent: HarnessEvent = { ...TOOL_BEFORE_EVENT, event: "read.before" };
  const askDecision: Decision = { kind: "ask", reason: "confirm read of a sensitive file", rule: "test-ask" };
  const degraded = degrade(askDecision, readBeforeEvent, claudeCapabilities());
  assert.equal(degraded.kind, "ask");
  const rendered = claudeRender(degraded, readBeforeEvent);
  assert.ok(rendered.stdout);
  assert.equal(JSON.parse(rendered.stdout as string).hookSpecificOutput.permissionDecision, "ask");
});
