import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { codexToEvent } from "../codex.inbound.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

/**
 * spec P3 AC3, and the highest-risk mapping in the adapter. `tool_input.command` on this payload holds patch text,
 * so routing it to `shell.*` would match a patch body against every shell-command rule an operator wrote and
 * report every Codex edit as a shell execution.
 */
test("apply_patch maps to tool.before, because tool_input.command is patch text and not a command", () => {
  const payload = fixture("pre-tool-use-apply-patch.json");
  const input = payload.tool_input as Record<string, unknown>;
  assert.ok(
    String(input.command).startsWith("*** Begin Patch"),
    "precondition: the command field holds a patch",
  );
  assert.equal(codexToEvent(payload)?.event, "tool.before");
});

test("apply_patch maps to tool.after for the same reason", () => {
  assert.equal(codexToEvent(fixture("post-tool-use-apply-patch.json"))?.event, "tool.after");
});

// invariant: the patch body must not arrive as a shell command, which is the field a shell rule reads.
test("an apply_patch event carries no command field, so no shell rule can match the patch body", () => {
  const event = codexToEvent(fixture("pre-tool-use-apply-patch.json"));
  assert.equal(event?.command, undefined);
  assert.equal(event?.toolName, "apply_patch");
});

test("Bash maps to the shell kinds and carries the command", () => {
  const before = codexToEvent(fixture("pre-tool-use-bash.json"));
  assert.equal(before?.event, "shell.before");
  assert.equal(before?.command, "rm -rf /");
  assert.equal(codexToEvent(fixture("post-tool-use-bash.json"))?.event, "shell.after");
});

test("an mcp__ tool name maps to the mcp kinds and carries the tool name and input", () => {
  const before = codexToEvent(fixture("pre-tool-use-mcp.json"));
  assert.equal(before?.event, "mcp.before");
  assert.equal(before?.toolName, "mcp__github__create_issue");
  assert.deepEqual(before?.toolInput, { title: "flaky test", repo: "acme/app" });
  assert.equal(codexToEvent(fixture("post-tool-use-mcp.json"))?.event, "mcp.after");
});

test("an unknown tool name falls to the generic kinds rather than returning null", () => {
  const before = codexToEvent({ hook_event_name: "PreToolUse", cwd: "/repo", tool_name: "SomeNewTool" });
  assert.equal(before?.event, "tool.before");
  assert.equal(before?.toolName, "SomeNewTool");
});

/**
 * why the same fan-out as `PreToolUse`: `PermissionRequest` is the same moment in the turn — a tool about to run.
 * The two differ in the response vocabulary, which is the renderer's problem (spec P3 AC4), not the parser's.
 */
test("a PermissionRequest fans out by tool name to the before-kinds", () => {
  const event = codexToEvent(fixture("permission-request-bash.json"));
  assert.equal(event?.event, "shell.before");
  assert.equal(event?.command, "npm publish");
});

test("the documented session and turn events map to their kinds", () => {
  const expected: [string, string][] = [
    ["session-start.json", "session.start"],
    ["session-end.json", "session.end"],
    ["user-prompt-submit.json", "prompt.submit"],
    ["subagent-start.json", "subagent.start"],
    ["subagent-stop.json", "subagent.stop"],
    ["stop.json", "stop"],
    ["pre-compact.json", "compact.before"],
  ];
  for (const [name, kind] of expected) {
    assert.equal(codexToEvent(fixture(name))?.event, kind, name);
  }
});

/**
 * why these two are dropped rather than approximated: `HarnessEventKind` has no compact-after and no interrupt
 * member. Mapping either to a near-enough kind would deliver it to rules written for a different moment.
 */
test("PostCompact and Interrupt are unmapped, because the union has no honest kind for them", () => {
  assert.equal(codexToEvent(fixture("post-compact.json")), null);
  assert.equal(codexToEvent(fixture("interrupt.json")), null);
});

test("an event name the reference does not list returns null rather than a guessed kind", () => {
  assert.equal(codexToEvent(fixture("unknown-event.json")), null);
});

test("a payload with no hook_event_name returns null instead of throwing", () => {
  assert.equal(codexToEvent({ cwd: "/repo" }), null);
  assert.equal(codexToEvent({ hook_event_name: 7 }), null);
});

test("every event carries the provider name, a codex-scoped session key, and the project dir", () => {
  const event = codexToEvent(fixture("pre-tool-use-bash.json"));
  assert.equal(event?.provider, "codex");
  assert.equal(event?.sessionKey, "codex-01JCODEXSESSION0000000000");
  assert.equal(event?.projectDir, "/repo");
  assert.equal(event?.cwd, "/repo");
  assert.equal(event?.permissionMode, "on-request");
});

test("a payload with no cwd anchors on the process directory rather than on an empty string", () => {
  const event = codexToEvent({ hook_event_name: "Stop", session_id: "s1" });
  assert.equal(event?.projectDir, process.cwd());
  assert.equal(event?.cwd, undefined);
});

// why: `toolOutputAtAfter` is true only because `tool_response` is documented on PostToolUse and nowhere else.
test("tool_response is serialised onto the after-event and absent from the before-event", () => {
  const after = codexToEvent(fixture("post-tool-use-bash.json"));
  assert.equal(after?.toolOutput, JSON.stringify({ exit_code: 0, stdout: "2527 passing\n", stderr: "" }));
  assert.equal(codexToEvent(fixture("pre-tool-use-bash.json"))?.toolOutput, undefined);
});

/**
 * invariant: the boolean never becomes the count. `effectiveLoopCount` compares `loopCount` against the grind cap
 * as a number, so a boolean mapped in would yield at most 1 and the cap would never be reached
 * ([/decisions/ad-123.md](/decisions/ad-123.md)).
 */
test("stop_hook_active never reaches loopCount", () => {
  assert.equal(codexToEvent(fixture("stop-loop-active.json"))?.loopCount, undefined);
  assert.equal(codexToEvent(fixture("stop.json"))?.loopCount, undefined);
});

// hazard: `agent_type` is what the spawn was called, not the type it declared. A rule matching on it would match
// a string the gated agent chose.
test("a subagent event carries agent_type as the label and declares no subagent type", () => {
  const event = codexToEvent(fixture("subagent-stop.json"));
  assert.equal(event?.spawnAgentLabel, "explore");
  assert.equal(event?.spawnSubagentType, undefined);
});

test("a session event carries the model and the transcript path", () => {
  const event = codexToEvent(fixture("session-start.json"));
  assert.equal(event?.model, "gpt-5.1-codex");
  assert.equal(event?.transcriptPath, "/Users/dev/.codex/sessions/01JCODEXSESSION0000000000.jsonl");
});

test("the raw payload rides along untouched for the renderer to read the hook name from", () => {
  const payload = fixture("permission-request-bash.json");
  assert.equal(codexToEvent(payload)?.raw.hook_event_name, "PermissionRequest");
});
