import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cursorToEvent } from "../cursor.inbound.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

test("sessionStart maps to session.start and carries the model", () => {
  const event = cursorToEvent(fixture("session-start"));
  assert.ok(event);
  assert.equal(event?.provider, "cursor");
  assert.equal(event?.event, "session.start");
  assert.equal(event?.model, "composer-2.5");
});

test("sessionEnd maps to session.end", () => {
  const event = cursorToEvent(fixture("session-end"));
  assert.equal(event?.event, "session.end");
});

test("beforeSubmitPrompt maps to prompt.submit and carries text from prompt", () => {
  const event = cursorToEvent(fixture("prompt-submit"));
  assert.equal(event?.event, "prompt.submit");
  assert.equal(event?.text, "add a login form");
});

test("preToolUse maps to tool.before and carries toolName, toolInput, subagentType", () => {
  const event = cursorToEvent(fixture("tool-before"));
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.toolName, "Task");
  assert.deepEqual(event?.toolInput, { model: "composer-2.5", prompt: "explore the repo" });
  assert.equal(event?.subagentType, "explore");
});

test("postToolUse maps to tool.after and carries toolName", () => {
  const event = cursorToEvent(fixture("tool-after"));
  assert.equal(event?.event, "tool.after");
  assert.equal(event?.toolName, "Edit");
});

test("postToolUseFailure maps to tool.failure and carries toolName", () => {
  const event = cursorToEvent(fixture("tool-failure"));
  assert.equal(event?.event, "tool.failure");
  assert.equal(event?.toolName, "Edit");
});

test("beforeShellExecution maps to shell.before and carries command", () => {
  const event = cursorToEvent(fixture("shell-before"));
  assert.equal(event?.event, "shell.before");
  assert.equal(event?.command, "rm -rf /");
});

// why: cursor.com/docs/hooks confirms `cwd` exists only on `beforeShellExecution` — the one event kind
// this adapter promotes it for ([/decisions/ad-114.md](/decisions/ad-114.md)).
test("beforeShellExecution carries cwd onto the event", () => {
  const event = cursorToEvent(fixture("shell-before"));
  assert.equal(event?.cwd, "/repo");
});

test("afterShellExecution maps to shell.after and carries command", () => {
  const event = cursorToEvent(fixture("shell-after"));
  assert.equal(event?.event, "shell.after");
  assert.equal(event?.command, "npm test");
});

// why: the host does not document `cwd` on `afterShellExecution`, so it is never mapped here even
// though the fixture (modeled loosely on a real payload) happens to carry one.
test("afterShellExecution does not carry cwd, even when the raw payload has one", () => {
  const event = cursorToEvent(fixture("shell-after"));
  assert.equal(event?.cwd, undefined);
});

test("beforeMCPExecution maps to mcp.before and carries toolName and toolInput", () => {
  const event = cursorToEvent(fixture("mcp-before"));
  assert.equal(event?.event, "mcp.before");
  assert.equal(event?.toolName, "mcp__search__query");
  assert.deepEqual(event?.toolInput, { q: "harness" });
});

test("afterMCPExecution maps to mcp.after and carries toolName and toolInput", () => {
  const event = cursorToEvent(fixture("mcp-after"));
  assert.equal(event?.event, "mcp.after");
  assert.equal(event?.toolName, "mcp__search__query");
  assert.deepEqual(event?.toolInput, { q: "harness" });
});

test("beforeReadFile maps to read.before and carries filePath", () => {
  const event = cursorToEvent(fixture("read-before"));
  assert.equal(event?.event, "read.before");
  assert.equal(event?.filePath, "src/index.ts");
});

test("afterFileEdit maps to edit.after and carries filePath", () => {
  const event = cursorToEvent(fixture("edit-after"));
  assert.equal(event?.event, "edit.after");
  assert.equal(event?.filePath, "src/index.ts");
});

test("subagentStart maps to subagent.start and carries the spawn target, not the caller", () => {
  const event = cursorToEvent(fixture("subagent-start"));
  assert.equal(event?.event, "subagent.start");
  assert.equal(event?.spawnSubagentType, "worker");
  assert.equal(event?.spawnModel, "composer-2.5");
  assert.equal(event?.subagentType, undefined);
});

test("subagentStop maps to subagent.stop and carries the spawn target", () => {
  const event = cursorToEvent(fixture("subagent-stop"));
  assert.equal(event?.event, "subagent.stop");
  assert.equal(event?.spawnSubagentType, "worker");
  assert.equal(event?.subagentType, undefined);
});

test("subagentStart never populates model, so parent sticky state is not clobbered", () => {
  const event = cursorToEvent(fixture("subagent-start"));
  assert.equal(event?.model, undefined);
});

test("stop maps to stop and carries status, loopCount, contextUsagePercent", () => {
  const event = cursorToEvent(fixture("stop"));
  assert.equal(event?.event, "stop");
  assert.equal(event?.status, "completed");
  assert.equal(event?.loopCount, 2);
  assert.equal(event?.contextUsagePercent, 42);
});

test("preCompact maps to compact.before and carries contextUsagePercent", () => {
  const event = cursorToEvent(fixture("compact-before"));
  assert.equal(event?.event, "compact.before");
  assert.equal(event?.contextUsagePercent, 88);
});

test("afterAgentResponse maps to response.after and carries text", () => {
  const event = cursorToEvent(fixture("response-after"));
  assert.equal(event?.event, "response.after");
  assert.equal(event?.raw.text, "HARNESS_SHIP_CLAIM: shipped the login form.");
  assert.equal(event?.text, "HARNESS_SHIP_CLAIM: shipped the login form.");
});

test("effort is never set — Cursor reports no effort signal", () => {
  const event = cursorToEvent(fixture("tool-before"));
  assert.equal(event?.effort, undefined);
});

test("sessionKey is cursor-<sanitized conversation_id> when present", () => {
  const event = cursorToEvent(fixture("session-start"));
  assert.equal(event?.sessionKey, "cursor-conv-abc");
});

test("sessionKey falls back to session_id, then to default, when conversation_id is absent", () => {
  const bySession = cursorToEvent({
    hook_event_name: "sessionStart",
    session_id: "sess-only",
    workspace_roots: ["/repo"],
  });
  assert.equal(bySession?.sessionKey, "cursor-sess-only");

  const byDefault = cursorToEvent({ hook_event_name: "sessionStart", workspace_roots: ["/repo"] });
  assert.equal(byDefault?.sessionKey, "cursor-default");
});

test("projectDir resolves CURSOR_PROJECT_DIR over workspace_roots[0] over cwd", () => {
  const withoutEnv = cursorToEvent({
    hook_event_name: "sessionStart",
    workspace_roots: ["/from-workspace-roots"],
  });
  assert.equal(withoutEnv?.projectDir, "/from-workspace-roots");

  const previous = process.env.CURSOR_PROJECT_DIR;
  process.env.CURSOR_PROJECT_DIR = "/from-env";
  try {
    const withEnv = cursorToEvent({
      hook_event_name: "sessionStart",
      workspace_roots: ["/from-workspace-roots"],
    });
    assert.equal(withEnv?.projectDir, "/from-env");
  } finally {
    if (previous === undefined) {
      delete process.env.CURSOR_PROJECT_DIR;
    } else {
      process.env.CURSOR_PROJECT_DIR = previous;
    }
  }

  const withoutWorkspaceRoots = cursorToEvent({ hook_event_name: "sessionStart", workspace_roots: [] });
  assert.equal(withoutWorkspaceRoots?.projectDir, process.cwd());
});

test("afterAgentThought maps to thought.after and carries text from thought", () => {
  const event = cursorToEvent(fixture("after-agent-thought"));
  assert.equal(event?.event, "thought.after");
  assert.equal(event?.text, "considering next step");
});

test("afterAgentThought carries text when the payload uses text instead of thought", () => {
  const event = cursorToEvent({
    hook_event_name: "afterAgentThought",
    conversation_id: "conv-abc",
    workspace_roots: ["/repo"],
    text: "weighing two options",
  });
  assert.equal(event?.event, "thought.after");
  assert.equal(event?.text, "weighing two options");
});

test("afterAgentThought prefers thought over text when both are present", () => {
  const event = cursorToEvent({
    hook_event_name: "afterAgentThought",
    conversation_id: "conv-abc",
    workspace_roots: ["/repo"],
    thought: "from thought",
    text: "from text",
  });
  assert.equal(event?.text, "from thought");
});

test("afterAgentThought leaves text unset when neither field is present", () => {
  const event = cursorToEvent({
    hook_event_name: "afterAgentThought",
    conversation_id: "conv-abc",
    workspace_roots: ["/repo"],
  });
  assert.equal(event?.event, "thought.after");
  assert.equal(event?.text, undefined);
});

test("an entirely unknown hook_event_name returns null rather than throwing", () => {
  assert.doesNotThrow(() => cursorToEvent(fixture("unknown-event")));
  assert.equal(cursorToEvent(fixture("unknown-event")), null);
});

test("a missing hook_event_name returns null", () => {
  assert.equal(cursorToEvent({ workspace_roots: ["/repo"] }), null);
});
