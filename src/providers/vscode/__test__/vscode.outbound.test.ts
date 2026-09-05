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
 * spec P4 AC4 as amended during T2: context rides `hookSpecificOutput.additionalContext` at `SessionStart` only.
 * The VS Code page documents the field on that event alone ([/decisions/ad-125.md](/decisions/ad-125.md)).
 */
test("context at SessionStart rides hookSpecificOutput.additionalContext", () => {
  const output = hookSpecificOutput({ kind: "context", text: "three lessons apply here" }, sessionStart);
  assert.equal(output.hookEventName, "SessionStart");
  assert.equal(output.additionalContext, "three lessons apply here");
});

/**
 * `degrade()` gates context on `tool.before`, `tool.after` and `stop` only, so a context decision at
 * `shell.before` or `edit.after` reaches the renderer intact on this host. Rendering it into a field VS Code
 * ignores would leave the caller believing it was delivered ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("context anywhere but SessionStart renders nothing rather than a field this host ignores", () => {
  for (const fixtureName of [
    "pre-tool-use-terminal.json",
    "pre-tool-use-read.json",
    "post-tool-use-edit.json",
    "user-prompt-submit.json",
    "stop.json",
  ]) {
    const rendered = vscodeRender({ kind: "context", text: "ignored" }, eventFrom(fixtureName));
    assert.equal(rendered.stdout, null, fixtureName);
    assert.equal(rendered.exitCode, 0, fixtureName);
  }
});

test("the context channels AD-125 removed are stripped by degrade before the renderer runs", () => {
  const capabilities = vscodeCapabilities();
  const toolAfter: HarnessEvent = { ...eventFrom("post-tool-use-terminal.json"), event: "tool.after" };
  for (const event of [eventFrom("pre-tool-use-unknown.json"), toolAfter, eventFrom("stop.json")]) {
    const degraded = degrade({ kind: "context", text: "stripped" }, event, capabilities);
    assert.deepEqual(degraded, { kind: "abstain" }, event.event);
  }
});

/**
 * The reason the renderer needs its own guard: `degrade()` reads the three flags on `tool.before`, `tool.after`
 * and `stop` only, so a context decision at any other kind arrives intact — on a host whose only context channel
 * is `SessionStart`.
 */
test("degrade does not strip context at the other before-kinds, so the renderer's guard is load-bearing", () => {
  const capabilities = vscodeCapabilities();
  for (const fixtureName of [
    "pre-tool-use-terminal.json",
    "pre-tool-use-read.json",
    "post-tool-use-edit.json",
  ]) {
    const event = eventFrom(fixtureName);
    const degraded = degrade({ kind: "context", text: "kept" }, event, capabilities);
    assert.equal(degraded.kind, "context", `${fixtureName} (${event.event})`);
    assert.equal(vscodeRender(degraded, event).stdout, null, fixtureName);
  }
});

test("context at SessionStart survives degrade, so the renderer's one context branch is reachable", () => {
  const degraded = degrade({ kind: "context", text: "kept" }, sessionStart, vscodeCapabilities());
  assert.deepEqual(degraded, { kind: "context", text: "kept" });
});

test("abstain renders silence", () => {
  assert.equal(vscodeRender({ kind: "abstain" }, toolBefore).stdout, null);
});

/**
 * `toolInputRewrite` is false, so `degrade()` turns a rewrite into an ask — which this host does support on the
 * four before-kinds. The renderer's own branch is what a caller that skipped `degrade()` falls to: silence, never
 * an `updatedInput` the descriptor says the host does not read.
 */
test("a rewrite is degraded to an ask, and renders as silence if it reaches the renderer anyway", () => {
  const rewrite: Decision = { kind: "rewriteInput", input: { command: "ls" }, reason: "safer" };
  const degraded = degrade(rewrite, toolBefore, vscodeCapabilities());
  assert.equal(degraded.kind, "ask");
  const rendered = vscodeRender(rewrite, toolBefore);
  assert.equal(rendered.stdout, null);
  assert.equal(rendered.exitCode, 0);
});

test("a continue hands its text back through the stop channel", () => {
  const parsed = stdoutOf({ kind: "continue", text: "the gate has not run" }, eventFrom("stop.json"));
  assert.deepEqual(parsed, { decision: "block", reason: "the gate has not run" });
});

/**
 * why a refusal is emitted where context is not: the host offers no second channel for a refusal, so dropping one
 * lets through the exact action a rail refused. Dropping context costs a note nobody reads.
 */
test("a deny outside PreToolUse is still emitted rather than dropped", () => {
  const output = hookSpecificOutput(
    { kind: "deny", reason: "no", rule: "test-rule" },
    eventFrom("user-prompt-submit.json"),
  );
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.equal(output.permissionDecision, "deny");
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
