import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Decision, HarnessEvent } from "../../../contracts/index.ts";
import { codexToEvent } from "../codex.inbound.ts";
import { codexRender } from "../codex.outbound.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

function eventFrom(name: string): HarnessEvent {
  const event = codexToEvent(fixture(name));
  assert.ok(event, `${name} must parse`);
  return event;
}

function parsed(stdout: string | null): Record<string, unknown> {
  assert.ok(stdout, "expected stdout");
  return JSON.parse(stdout) as Record<string, unknown>;
}

const permissionRequest = eventFrom("permission-request-bash.json");
const preToolUse = eventFrom("pre-tool-use-bash.json");

/**
 * spec P3 AC4. Any verdict other than a refusal leaves Codex's own prompt in control, because answering this
 * event with an approval turns an escalation the operator was about to see into an automatic yes.
 */
test("a PermissionRequest renders empty stdout for allow, ask, abstain, and a rewrite", () => {
  const silent: Decision[] = [
    { kind: "allow" },
    { kind: "ask", reason: "escalate this", rule: "r" },
    { kind: "abstain" },
    { kind: "rewriteInput", input: { command: "npm publish --dry-run" }, reason: "safer" },
  ];
  for (const decision of silent) {
    const rendered = codexRender(decision, permissionRequest);
    assert.equal(rendered.stdout, null, decision.kind);
    assert.equal(rendered.exitCode, 0, decision.kind);
  }
});

/**
 * spec P3 AC4, second half. This event's own vocabulary is `decision.behavior` with a `message` — not the
 * `permissionDecision` field `PreToolUse` speaks.
 */
test("a PermissionRequest deny renders decision.behavior deny with the reason as the message", () => {
  const rendered = codexRender(
    { kind: "deny", reason: "publishing is gated", rule: "no-publish" },
    permissionRequest,
  );
  assert.deepEqual(parsed(rendered.stdout), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "publishing is gated" },
    },
  });
  assert.equal(rendered.exitCode, 0);
});

test("a PermissionRequest deny does not speak permissionDecision, which belongs to the other event", () => {
  const rendered = codexRender({ kind: "deny", reason: "no", rule: "r" }, permissionRequest);
  assert.ok(rendered.stdout);
  assert.doesNotMatch(rendered.stdout, /permissionDecision/);
});

/**
 * spec P3 AC5. Codex errors when `allow` is omitted, which is the opposite of the host whose shape this mirrors —
 * so the two fields ride together or the rewrite fails.
 */
test("a PreToolUse rewrite emits permissionDecision allow together with updatedInput", () => {
  const rendered = codexRender(
    { kind: "rewriteInput", input: { command: "rm -rf ./build" }, reason: "scoped" },
    preToolUse,
  );
  assert.deepEqual(parsed(rendered.stdout), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: "rm -rf ./build" },
    },
  });
});

test("a PreToolUse deny speaks permissionDecision and carries the reason", () => {
  const rendered = codexRender({ kind: "deny", reason: "rm -rf is gated", rule: "no-rm" }, preToolUse);
  assert.deepEqual(parsed(rendered.stdout), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "rm -rf is gated",
    },
  });
});

test("a PreToolUse allow speaks permissionDecision allow", () => {
  const rendered = codexRender({ kind: "allow" }, preToolUse);
  assert.deepEqual(parsed(rendered.stdout), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  });
});

/**
 * invariant: an ask never reaches the wire as an ask on this host. Codex parses `permissionDecision: "ask"` and
 * runs the tool anyway, so emitting it would approve the action the rail wanted escalated. `degrade()` already
 * converts it; this is what makes a caller that skipped `degrade()` fail safe rather than silently open.
 */
test("a PreToolUse ask renders as a refusal carrying the reason, never as ask", () => {
  const rendered = codexRender({ kind: "ask", reason: "human should decide", rule: "r" }, preToolUse);
  const output = parsed(rendered.stdout).hookSpecificOutput as Record<string, unknown>;
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.permissionDecisionReason, "human should decide");
});

test("an abstain renders nothing at all, on either event", () => {
  assert.equal(codexRender({ kind: "abstain" }, preToolUse).stdout, null);
  assert.equal(codexRender({ kind: "abstain" }, permissionRequest).stdout, null);
});

// why: `contextAtToolBefore` and `contextAtToolAfter` are true because both events accept this field.
test("a context decision rides additionalContext at the before and after events", () => {
  for (const event of [preToolUse, eventFrom("post-tool-use-bash.json")]) {
    const rendered = codexRender({ kind: "context", text: "recent lesson", env: {} }, event);
    const output = parsed(rendered.stdout).hookSpecificOutput as Record<string, unknown>;
    assert.equal(output.additionalContext, "recent lesson");
  }
});

// why: `Stop` and `PostToolUse` document `decision: "block"` with a reason as the channel that keeps the turn going.
test("a continue decision renders decision block with the reason", () => {
  const rendered = codexRender(
    { kind: "continue", text: "BLOCKED: finish the gate" },
    eventFrom("stop.json"),
  );
  assert.deepEqual(parsed(rendered.stdout), { decision: "block", reason: "BLOCKED: finish the gate" });
});

/**
 * The renderer tells the two vocabularies apart by reading the hook name off the payload, so an event whose raw
 * payload was not preserved still lands on a documented event name rather than on `undefined`.
 */
test("an event with no hook name in its payload falls back to the name its kind maps to", () => {
  const synthetic: HarnessEvent = {
    provider: "codex",
    event: "shell.before",
    sessionKey: "codex-s",
    projectDir: "/repo",
    raw: {},
  };
  const output = parsed(codexRender({ kind: "allow" }, synthetic).stdout).hookSpecificOutput as Record<
    string,
    unknown
  >;
  assert.equal(output.hookEventName, "PreToolUse");
});

test("exit code is 0 for every decision, on both vocabularies", () => {
  const decisions: Decision[] = [
    { kind: "abstain" },
    { kind: "allow" },
    { kind: "deny", reason: "r", rule: "x" },
    { kind: "ask", reason: "r", rule: "x" },
    { kind: "context", text: "t", env: {} },
    { kind: "continue", text: "t" },
    { kind: "rewriteInput", input: {}, reason: "r" },
  ];
  for (const decision of decisions) {
    assert.equal(codexRender(decision, preToolUse).exitCode, 0, decision.kind);
    assert.equal(codexRender(decision, permissionRequest).exitCode, 0, decision.kind);
  }
});
