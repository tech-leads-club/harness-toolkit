import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorCapabilities } from "../cursor.capabilities.ts";
import { detectCursor } from "../cursor.detect.ts";

test("detects a sessionStart payload", () => {
  assert.equal(detectCursor({ hook_event_name: "sessionStart", workspace_roots: ["/repo"] }), true);
});

test("detects a preToolUse payload", () => {
  assert.equal(
    detectCursor({ hook_event_name: "preToolUse", workspace_roots: ["/repo"], tool_name: "Task" }),
    true,
  );
});

test("detects a beforeShellExecution payload", () => {
  assert.equal(
    detectCursor({ hook_event_name: "beforeShellExecution", workspace_roots: ["/repo"], command: "ls" }),
    true,
  );
});

test("detects a stop payload", () => {
  assert.equal(
    detectCursor({ hook_event_name: "stop", workspace_roots: ["/repo"], status: "completed" }),
    true,
  );
});

test("detects an afterAgentResponse payload", () => {
  assert.equal(
    detectCursor({ hook_event_name: "afterAgentResponse", workspace_roots: ["/repo"], text: "done" }),
    true,
  );
});

test("detects a subagentStart payload", () => {
  assert.equal(
    detectCursor({ hook_event_name: "subagentStart", workspace_roots: ["/repo"], subagent_type: "explore" }),
    true,
  );
});

test("rejects a Claude payload (PascalCase event, no workspace_roots)", () => {
  assert.equal(
    detectCursor({ hook_event_name: "SessionStart", cwd: "/repo", transcript_path: "/tmp/t.jsonl" }),
    false,
  );
});

test("rejects an empty object", () => {
  assert.equal(detectCursor({}), false);
});

test("rejects null", () => {
  assert.equal(detectCursor(null), false);
});

test("rejects a non-object string", () => {
  assert.equal(detectCursor("sessionStart"), false);
});

test("rejects a non-object array", () => {
  assert.equal(detectCursor(["sessionStart"]), false);
});

test("capabilities match the design table exactly", () => {
  assert.deepEqual(cursorCapabilities(), {
    enforcesHooks: true,
    askSupportedOn: ["shell.before", "mcp.before"],
    sessionEnv: true,
    nativeLoopCounter: true,
    dedicatedShellEvent: true,
    toolInputRewrite: true,
    toolOutputRewrite: true,
    contextAtToolBefore: false,
    contextAtToolAfter: true,
    toolOutputAtAfter: true,
    contextAtStop: false,
    sessionStartContextReliable: false,
    usageInPayload: true,
    effortSignal: false,
    thoughtEvent: true,
  });
});
