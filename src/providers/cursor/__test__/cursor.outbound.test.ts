import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Decision, HarnessEvent } from "../../../contracts/index.ts";
import { degrade } from "../../provider.degrade.ts";
import { cursorCapabilities } from "../cursor.capabilities.ts";
import { cursorRender } from "../cursor.outbound.ts";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

function golden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.json`), "utf8");
}

const EVENT: HarnessEvent = {
  provider: "cursor",
  event: "stop",
  sessionKey: "cursor-contract-probe",
  projectDir: "/tmp",
  raw: {},
};

// why: goldens under __test__/golden/ are captured verbatim from the pre-refactor handlers, except
// rewrite-input.json, which is hand-written (no legacy decision kind produced `updated_input`).

test('allow renders {"permission":"allow"} — captured from guard-mcp.mjs / guard-read.mjs', () => {
  const rendered = cursorRender({ kind: "allow" }, EVENT);
  assert.equal(rendered.stdout, golden("allow"));
  assert.equal(rendered.exitCode, 0);
});

test("ask reconstructs the exact captured guard-shell.mjs catastrophic-command output", () => {
  const parsed = JSON.parse(golden("ask")) as { user_message: string; agent_message: string };
  const decision: Decision = {
    kind: "ask",
    reason: parsed.agent_message,
    userNote: parsed.user_message,
    rule: "test-ask",
  };
  const rendered = cursorRender(decision, EVENT);
  assert.equal(rendered.stdout, golden("ask"));
  assert.equal(rendered.exitCode, 0);
});

test("deny reconstructs the exact captured guard-subagent.mjs blocked_pattern output", () => {
  const parsed = JSON.parse(golden("deny")) as { user_message: string; agent_message: string };
  const decision: Decision = {
    kind: "deny",
    reason: parsed.agent_message,
    userNote: parsed.user_message,
    rule: "test-deny",
  };
  const rendered = cursorRender(decision, EVENT);
  assert.equal(rendered.stdout, golden("deny"));
  assert.equal(rendered.exitCode, 0);
});

test("abstain renders the literal {} — captured from obs-passive.mjs", () => {
  const rendered = cursorRender({ kind: "abstain" }, EVENT);
  assert.equal(rendered.stdout, golden("abstain"));
  assert.notEqual(rendered.stdout, null);
});

test("context reconstructs the exact captured session-bootstrap.mjs first-boot output", () => {
  const parsed = JSON.parse(golden("context")) as { env: Record<string, string>; additional_context: string };
  const decision: Decision = { kind: "context", text: parsed.additional_context, env: parsed.env };
  const rendered = cursorRender(decision, EVENT);
  assert.equal(rendered.stdout, golden("context"));
});

test("context without env omits the env key entirely", () => {
  const rendered = cursorRender({ kind: "context", text: "hello" }, EVENT);
  assert.equal(rendered.stdout, '{"additional_context":"hello"}');
});

test("continue reconstructs the exact captured verify-gates.mjs lint-fail followup_message", () => {
  const parsed = JSON.parse(golden("continue")) as { followup_message: string };
  const decision: Decision = { kind: "continue", text: parsed.followup_message };
  const rendered = cursorRender(decision, EVENT);
  assert.equal(rendered.stdout, golden("continue"));
});

test("rewriteInput renders updated_input (hand-written — no legacy decision kind produced this)", () => {
  const decision: Decision = {
    kind: "rewriteInput",
    input: { command: "ls -la ./safe-dir" },
    reason: "scoped to a safe directory",
  };
  const rendered = cursorRender(decision, EVENT);
  assert.equal(rendered.stdout, golden("rewrite-input"));
});

test("rewriteInput never leaks the reason field into rendered output", () => {
  const rendered = cursorRender(
    { kind: "rewriteInput", input: { x: 1 }, reason: "should not appear" },
    EVENT,
  );
  assert.ok(rendered.stdout && !rendered.stdout.includes("should not appear"));
});

test("deny with no userNote omits user_message and keeps agent_message", () => {
  const rendered = cursorRender({ kind: "deny", reason: "no explicit model", rule: "test-deny" }, EVENT);
  assert.equal(rendered.stdout, '{"permission":"deny","agent_message":"no explicit model"}');
});

test("ask with no userNote omits user_message and keeps agent_message", () => {
  const rendered = cursorRender({ kind: "ask", reason: "confirm", rule: "test-ask" }, EVENT);
  assert.equal(rendered.stdout, '{"permission":"ask","agent_message":"confirm"}');
});

test("every decision kind renders with exit code 0 — exit code is never a policy channel", () => {
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
    assert.equal(cursorRender(decision, EVENT).exitCode, 0, decision.kind);
  }
});

test("render output does not depend on the event argument for a given decision", () => {
  const otherEvent: HarnessEvent = { ...EVENT, event: "tool.before", sessionKey: "cursor-other" };
  const decision: Decision = { kind: "allow" };
  assert.equal(cursorRender(decision, EVENT).stdout, cursorRender(decision, otherEvent).stdout);
});

test("context text with embedded quotes and newlines round-trips through JSON escaping", () => {
  const text = 'line one\nline "two" with quotes\tand a tab';
  const rendered = cursorRender({ kind: "context", text }, EVENT);
  assert.ok(rendered.stdout);
  assert.equal(JSON.parse(rendered.stdout as string).additional_context, text);
});

test("ask at tool.before never reaches the renderer — degrade converts it to deny first", () => {
  const toolBeforeEvent: HarnessEvent = { ...EVENT, event: "tool.before" };
  const askDecision: Decision = { kind: "ask", reason: "confirm deletion", rule: "test-ask" };
  const degraded = degrade(askDecision, toolBeforeEvent, cursorCapabilities());
  assert.equal(degraded.kind, "deny");
  const rendered = cursorRender(degraded, toolBeforeEvent);
  assert.ok(rendered.stdout && JSON.parse(rendered.stdout).permission === "deny");
});
