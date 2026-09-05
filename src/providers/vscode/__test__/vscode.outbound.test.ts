import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Decision, HarnessEvent } from "../../../contracts/index.ts";
import { degrade } from "../../provider.degrade.ts";
import { vscodeCapabilities } from "../vscode.capabilities.ts";
import { vscodeToEvent } from "../vscode.inbound.ts";
import { vscodeRender } from "../vscode.outbound.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function eventFrom(fixtureName: string): HarnessEvent {
  const raw = JSON.parse(readFileSync(join(HERE, "fixtures", fixtureName), "utf8")) as Record<
    string,
    unknown
  >;
  const event = vscodeToEvent(raw);
  assert.ok(event, `${fixtureName} parsed to null`);
  return event;
}

function stdoutOf(decision: Decision, event: HarnessEvent): Record<string, unknown> | null {
  const rendered = vscodeRender(decision, event);
  assert.equal(rendered.exitCode, 0);
  return rendered.stdout === null ? null : (JSON.parse(rendered.stdout) as Record<string, unknown>);
}

function hookSpecificOutput(decision: Decision, event: HarnessEvent): Record<string, unknown> {
  const parsed = stdoutOf(decision, event);
  assert.ok(parsed, "expected stdout, got silence");
  const output = parsed.hookSpecificOutput as Record<string, unknown>;
  assert.ok(output, "expected hookSpecificOutput");
  return output;
}

const toolBefore = eventFrom("pre-tool-use-terminal.json");
const sessionStart = eventFrom("session-start.json");

// spec P4 AC4: a PreToolUse decision renders permissionDecision of deny, ask, or allow.
test("a deny at PreToolUse renders permissionDecision deny with its reason", () => {
  const output = hookSpecificOutput(
    { kind: "deny", reason: "rm -rf is refused", rule: "no-recursive-remove" },
    toolBefore,
  );
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.permissionDecisionReason, "rm -rf is refused");
});

test("an ask at PreToolUse renders permissionDecision ask with its reason", () => {
  const output = hookSpecificOutput(
    { kind: "ask", reason: "confirm this command", rule: "confirm-shell" },
    toolBefore,
  );
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.permissionDecision, "ask");
  assert.equal(output.permissionDecisionReason, "confirm this command");
});

test("an allow at PreToolUse renders permissionDecision allow and no reason", () => {
  const output = hookSpecificOutput({ kind: "allow" }, toolBefore);
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.permissionDecision, "allow");
  assert.ok(!("permissionDecisionReason" in output));
});

/**
 * spec P4 AC4, corrected against the published reference: context rides `hookSpecificOutput.additionalContext`
 * on `PreToolUse`, `PostToolUse`, `SessionStart` and `SubagentStart`
 * ([/decisions/ad-125.md](/decisions/ad-125.md)).
 */
test("context rides hookSpecificOutput.additionalContext on each of the four events that accept it", () => {
  for (const [fixtureName, hookEventName] of [
    ["session-start.json", "SessionStart"],
    ["pre-tool-use-terminal.json", "PreToolUse"],
    ["post-tool-use-edit.json", "PostToolUse"],
    ["subagent-start.json", "SubagentStart"],
  ] as const) {
    const output = hookSpecificOutput(
      { kind: "context", text: "three lessons apply here" },
      eventFrom(fixtureName),
    );
    assert.equal(output.hookEventName, hookEventName, fixtureName);
    assert.equal(output.additionalContext, "three lessons apply here", fixtureName);
  }
});

/**
 * why the renderer keeps its own guard: `degrade()` gates context on `tool.before`, `tool.after` and `stop`
 * only, so a context decision at `prompt.submit` or `compact.before` reaches the renderer intact. Rendering it
 * into a field VS Code ignores would leave the caller believing it was delivered
 * ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("context on an event outside those four renders nothing rather than a field this host ignores", () => {
  for (const fixtureName of [
    "user-prompt-submit.json",
    "stop.json",
    "pre-compact.json",
    "subagent-stop.json",
  ]) {
    const rendered = vscodeRender({ kind: "context", text: "ignored" }, eventFrom(fixtureName));
    assert.equal(rendered.stdout, null, fixtureName);
    assert.equal(rendered.exitCode, 0, fixtureName);
  }
});

/**
 * `Stop` is the one context channel this host refuses: the published reference lists `additionalContext` on
 * `PreToolUse`, `PostToolUse`, `SessionStart` and `SubagentStart` and on no other event
 * ([/decisions/ad-125.md](/decisions/ad-125.md)).
 */
test("context at stop is stripped by degrade, and context at the two tool events survives it", () => {
  const capabilities = vscodeCapabilities();
  const toolAfter: HarnessEvent = { ...eventFrom("post-tool-use-terminal.json"), event: "tool.after" };
  const stripped = degrade({ kind: "context", text: "stripped" }, eventFrom("stop.json"), capabilities);
  assert.deepEqual(stripped, { kind: "abstain" });
  for (const event of [eventFrom("pre-tool-use-unknown.json"), toolAfter]) {
    const degraded = degrade({ kind: "context", text: "kept" }, event, capabilities);
    assert.deepEqual(degraded, { kind: "context", text: "kept" }, event.event);
  }
});

/**
 * The pair that matters end to end: a context decision at a tool event now survives `degrade()` and is
 * delivered, where before the flags were corrected it was stripped.
 */
test("context at a tool event survives degrade and is rendered", () => {
  const capabilities = vscodeCapabilities();
  for (const fixtureName of [
    "pre-tool-use-terminal.json",
    "pre-tool-use-read.json",
    "post-tool-use-edit.json",
  ]) {
    const event = eventFrom(fixtureName);
    const degraded = degrade({ kind: "context", text: "kept" }, event, capabilities);
    assert.equal(degraded.kind, "context", `${fixtureName} (${event.event})`);
    assert.equal(hookSpecificOutput(degraded, event).additionalContext, "kept", fixtureName);
  }
});

test("context at SessionStart survives degrade, so the renderer's context branch is reachable", () => {
  const degraded = degrade({ kind: "context", text: "kept" }, sessionStart, vscodeCapabilities());
  assert.deepEqual(degraded, { kind: "context", text: "kept" });
});

test("abstain renders silence", () => {
  assert.equal(vscodeRender({ kind: "abstain" }, toolBefore).stdout, null);
});

/**
 * `toolInputRewrite` is true — `hookSpecificOutput.updatedInput` is documented on `PreToolUse`
 * ([/decisions/ad-125.md](/decisions/ad-125.md)) — so `degrade()` carries a rewrite through untouched instead of
 * converting it to an ask.
 */
test("a rewrite survives degrade and renders hookSpecificOutput.updatedInput at PreToolUse", () => {
  const rewrite: Decision = { kind: "rewriteInput", input: { command: "ls" }, reason: "safer" };
  const degraded = degrade(rewrite, toolBefore, vscodeCapabilities());
  assert.deepEqual(degraded, rewrite);
  assert.deepEqual(stdoutOf(rewrite, toolBefore), {
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "ls" } },
  });
});

/** invariant: `updatedInput` is a `PreToolUse` field, so a rewrite reaching any other event renders silence. */
test("a rewrite outside PreToolUse renders silence", () => {
  const rewrite: Decision = { kind: "rewriteInput", input: { command: "ls" }, reason: "safer" };
  assert.equal(vscodeRender(rewrite, eventFrom("post-tool-use-edit.json")).stdout, null);
});

/**
 * One pair, two placements. On `Stop` the reference documents `decision` and `reason` inside
 * `hookSpecificOutput` beside `hookEventName`; on `PostToolUse` and `SubagentStop` it documents them top-level
 * ([/decisions/ad-125.md](/decisions/ad-125.md)).
 */
test("a continue at Stop nests decision and reason inside hookSpecificOutput", () => {
  const parsed = stdoutOf({ kind: "continue", text: "the gate has not run" }, eventFrom("stop.json"));
  assert.deepEqual(parsed, {
    hookSpecificOutput: {
      hookEventName: "Stop",
      decision: "block",
      reason: "the gate has not run",
    },
  });
});

test("a continue at PostToolUse and SubagentStop puts the same pair top-level", () => {
  for (const fixtureName of ["post-tool-use-edit.json", "subagent-stop.json"]) {
    const parsed = stdoutOf({ kind: "continue", text: "the gate has not run" }, eventFrom(fixtureName));
    assert.deepEqual(parsed, { decision: "block", reason: "the gate has not run" }, fixtureName);
  }
});

/**
 * hazard: a refusal raised outside `PreToolUse` is dropped, because `permissionDecision` is exclusive to that
 * event and emitting it elsewhere claimed a channel the host reads on no other event
 * ([/decisions/ad-125.md](/decisions/ad-125.md), [/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("a deny outside PreToolUse renders silence rather than a field this host ignores", () => {
  for (const fixtureName of ["user-prompt-submit.json", "post-tool-use-edit.json", "stop.json"]) {
    const rendered = vscodeRender({ kind: "deny", reason: "no", rule: "test-rule" }, eventFrom(fixtureName));
    assert.equal(rendered.stdout, null, fixtureName);
    assert.equal(rendered.exitCode, 0, fixtureName);
  }
});

// the hook name echoed back is the host's own, in whichever of the two documented spellings it arrived.
test("the hook name is read back off the camelCase payload too", () => {
  const output = hookSpecificOutput(
    { kind: "deny", reason: "no", rule: "test-rule" },
    eventFrom("pre-tool-use-terminal-camel.json"),
  );
  assert.equal(output.hookEventName, "PreToolUse");
});

test("a fabricated event with no hook name in raw falls back to the kind map", () => {
  const fabricated: HarnessEvent = {
    provider: "vscode",
    event: "read.before",
    sessionKey: "vscode-probe",
    projectDir: "/repo",
    raw: {},
  };
  assert.equal(hookSpecificOutput({ kind: "allow" }, fabricated).hookEventName, "PreToolUse");
});

test("every decision kind renders without throwing", () => {
  const decisions: Decision[] = [
    { kind: "abstain" },
    { kind: "allow" },
    { kind: "deny", reason: "r", rule: "test-rule" },
    { kind: "ask", reason: "r", rule: "test-rule" },
    { kind: "context", text: "t" },
    { kind: "continue", text: "t" },
    { kind: "rewriteInput", input: {}, reason: "r" },
  ];
  for (const decision of decisions) {
    assert.doesNotThrow(() => vscodeRender(decision, toolBefore), decision.kind);
  }
});
