import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCapabilities } from "../claude.capabilities.ts";
import { detectClaude } from "../claude.detect.ts";

test("detects a SessionStart payload with cwd", () => {
  assert.equal(detectClaude({ hook_event_name: "SessionStart", cwd: "/repo" }), true);
});

test("detects a PreToolUse payload with transcript_path", () => {
  assert.equal(
    detectClaude({
      hook_event_name: "PreToolUse",
      transcript_path: "/tmp/transcript.jsonl",
      tool_name: "Bash",
    }),
    true,
  );
});

test("detects a PostToolUse payload with both cwd and transcript_path", () => {
  assert.equal(
    detectClaude({
      hook_event_name: "PostToolUse",
      cwd: "/repo",
      transcript_path: "/tmp/transcript.jsonl",
      tool_name: "Edit",
    }),
    true,
  );
});

test("detects a Stop payload", () => {
  assert.equal(detectClaude({ hook_event_name: "Stop", cwd: "/repo" }), true);
});

test("detects a MessageDisplay payload", () => {
  assert.equal(detectClaude({ hook_event_name: "MessageDisplay", cwd: "/repo", text: "done" }), true);
});

test("detects a SubagentStart payload", () => {
  assert.equal(detectClaude({ hook_event_name: "SubagentStart", cwd: "/repo", tool_name: "Task" }), true);
});

test("rejects a Cursor payload (camelCase event, workspace_roots)", () => {
  assert.equal(detectClaude({ hook_event_name: "sessionStart", workspace_roots: ["/repo"] }), false);
});

test("rejects an empty object", () => {
  assert.equal(detectClaude({}), false);
});

test("rejects null", () => {
  assert.equal(detectClaude(null), false);
});

test("rejects a non-object string", () => {
  assert.equal(detectClaude("SessionStart"), false);
});

test("rejects a non-object array", () => {
  assert.equal(detectClaude(["SessionStart"]), false);
});

test("capabilities match the design table exactly", () => {
  assert.deepEqual(claudeCapabilities(), {
    enforcesHooks: true,
    askSupportedOn: ["tool.before", "shell.before", "mcp.before", "read.before"],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: true,
    toolOutputRewrite: true,
    contextAtToolBefore: true,
    contextAtToolAfter: true,
    toolOutputAtAfter: true,
    contextAtStop: true,
    sessionStartContextReliable: true,
    usageInPayload: false,
    effortSignal: true,
    thoughtEvent: false,
  });
});
