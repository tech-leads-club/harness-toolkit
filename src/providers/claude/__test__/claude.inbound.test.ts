import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeToEvent } from "../claude.inbound.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

test("SessionStart maps to session.start and carries the model", () => {
  const event = claudeToEvent(fixture("session-start"));
  assert.ok(event);
  assert.equal(event?.provider, "claude");
  assert.equal(event?.event, "session.start");
  assert.equal(event?.model, "claude-opus-5");
});

test("SessionEnd maps to session.end", () => {
  const event = claudeToEvent(fixture("session-end"));
  assert.equal(event?.event, "session.end");
});

test("UserPromptSubmit maps to prompt.submit and carries text from prompt", () => {
  const event = claudeToEvent(fixture("user-prompt-submit"));
  assert.equal(event?.event, "prompt.submit");
  assert.equal(event?.text, "add a login form");
});

test("PreToolUse + Bash fans out to shell.before with command from tool_input.command", () => {
  const event = claudeToEvent(fixture("pre-tool-use-bash"));
  assert.equal(event?.event, "shell.before");
  assert.equal(event?.command, "rm -rf /");
});

test("PreToolUse + mcp__* fans out to mcp.before with toolName and toolInput", () => {
  const event = claudeToEvent(fixture("pre-tool-use-mcp"));
  assert.equal(event?.event, "mcp.before");
  assert.equal(event?.toolName, "mcp__search__query");
  assert.deepEqual(event?.toolInput, { q: "harness" });
});

test("PreToolUse + Read fans out to read.before with filePath", () => {
  const event = claudeToEvent(fixture("pre-tool-use-read"));
  assert.equal(event?.event, "read.before");
  assert.equal(event?.filePath, "src/index.ts");
});

test("PreToolUse + Task fans out to tool.before and retains toolInput", () => {
  const event = claudeToEvent(fixture("pre-tool-use-task"));
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.toolName, "Task");
  assert.deepEqual(event?.toolInput, { subagent_type: "explore", prompt: "explore the repo" });
  assert.equal(event?.spawnSubagentType, "explore");
});

test("PreToolUse + Edit fans out to tool.before with filePath for the collision check", () => {
  const event = claudeToEvent(fixture("pre-tool-use-edit"));
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.filePath, "src/index.ts");
});

test("PreToolUse + Write fans out to tool.before with filePath for the collision check", () => {
  const event = claudeToEvent(fixture("pre-tool-use-write"));
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.filePath, "src/new-file.ts");
});

test("PostToolUse + Bash fans out to shell.after with command", () => {
  const event = claudeToEvent(fixture("post-tool-use-bash"));
  assert.equal(event?.event, "shell.after");
  assert.equal(event?.command, "npm test");
});

test("PostToolUse + mcp__* fans out to mcp.after with toolName and toolInput", () => {
  const event = claudeToEvent(fixture("post-tool-use-mcp"));
  assert.equal(event?.event, "mcp.after");
  assert.equal(event?.toolName, "mcp__search__query");
  assert.deepEqual(event?.toolInput, { q: "harness" });
});

test("PostToolUse + Edit fans out to edit.after with filePath", () => {
  const event = claudeToEvent(fixture("post-tool-use-edit"));
  assert.equal(event?.event, "edit.after");
  assert.equal(event?.filePath, "src/index.ts");
});

test("PostToolUse + Write fans out to edit.after with filePath", () => {
  const event = claudeToEvent(fixture("post-tool-use-write"));
  assert.equal(event?.event, "edit.after");
  assert.equal(event?.filePath, "src/new-file.ts");
});

test("PostToolUse + a generic tool_name falls back to tool.after", () => {
  const event = claudeToEvent(fixture("post-tool-use-generic"));
  assert.equal(event?.event, "tool.after");
  assert.equal(event?.toolName, "Task");
});

test("PostToolUseFailure maps to tool.failure and carries toolName", () => {
  const event = claudeToEvent(fixture("post-tool-use-failure"));
  assert.equal(event?.event, "tool.failure");
  assert.equal(event?.toolName, "Edit");
});

test("SubagentStart maps to subagent.start and carries the spawn target, not the caller", () => {
  const event = claudeToEvent(fixture("subagent-start"));
  assert.equal(event?.event, "subagent.start");
  assert.equal(event?.spawnSubagentType, "worker");
  assert.equal(event?.subagentType, undefined);
});

test("SubagentStop maps to subagent.stop and carries the spawn target", () => {
  const event = claudeToEvent(fixture("subagent-stop"));
  assert.equal(event?.event, "subagent.stop");
  assert.equal(event?.spawnSubagentType, "worker");
  assert.equal(event?.subagentType, undefined);
});

test("agent_type populates the caller identity on an ordinary tool event", () => {
  const event = claudeToEvent({
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    cwd: "/repo",
    tool_name: "Write",
    tool_input: { file_path: "src/index.ts" },
    agent_type: "explore",
  });
  assert.equal(event?.subagentType, "explore");
  assert.equal(event?.spawnSubagentType, undefined);
});

test("Stop maps to stop and carries status and contextUsagePercent, with loopCount absent", () => {
  const event = claudeToEvent(fixture("stop"));
  assert.equal(event?.event, "stop");
  assert.equal(event?.status, "completed");
  assert.equal(event?.contextUsagePercent, 42);
  assert.equal(event?.loopCount, undefined);
});

test("PreCompact maps to compact.before and carries contextUsagePercent", () => {
  const event = claudeToEvent(fixture("compact-before"));
  assert.equal(event?.event, "compact.before");
  assert.equal(event?.contextUsagePercent, 88);
});

test("MessageDisplay maps to response.after and carries text", () => {
  const event = claudeToEvent(fixture("message-display"));
  assert.equal(event?.event, "response.after");
  assert.equal(event?.text, "HARNESS_SHIP_CLAIM: shipped the login form.");
});

test("sessionKey is claude-<sanitized session_id>", () => {
  const event = claudeToEvent(fixture("session-start"));
  assert.equal(event?.sessionKey, "claude-sess-abc");
});

test("sessionKey falls back to default when session_id is absent", () => {
  const event = claudeToEvent({ hook_event_name: "SessionStart", cwd: "/repo" });
  assert.equal(event?.sessionKey, "claude-default");
});

// hazard: two of the three cases assert what happens with CLAUDE_PROJECT_DIR ABSENT, so the test has to make
// it absent rather than inherit that from the shell. Trusting the ambient value made this pass locally and fail
// inside a hook, where Claude Code always sets it — and it took 21 unrelated tests down with it. The variable
// is owned for the whole test and restored once, so no case leaks state into the next.
test("projectDir resolves CLAUDE_PROJECT_DIR over cwd over process.cwd()", () => {
  const previous = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    const fromCwd = claudeToEvent({ hook_event_name: "SessionStart", session_id: "s", cwd: "/from-cwd" });
    assert.equal(fromCwd?.projectDir, "/from-cwd");

    process.env.CLAUDE_PROJECT_DIR = "/from-env";
    const fromEnv = claudeToEvent({ hook_event_name: "SessionStart", session_id: "s", cwd: "/from-cwd" });
    assert.equal(fromEnv?.projectDir, "/from-env");

    delete process.env.CLAUDE_PROJECT_DIR;
    const fromProcess = claudeToEvent({
      hook_event_name: "SessionStart",
      session_id: "s",
      transcript_path: "/t",
    });
    assert.equal(fromProcess?.projectDir, process.cwd());
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = previous;
    }
  }
});

// why: `cwd` and `projectDir` must be able to diverge — that divergence is the whole point of AD-114.
// `projectDir` prefers CLAUDE_PROJECT_DIR; `event.cwd` always carries the raw payload's own `cwd`,
// regardless of what CLAUDE_PROJECT_DIR says.
test("cwd carries the raw payload's own cwd even when CLAUDE_PROJECT_DIR points elsewhere", () => {
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = "/main-checkout";
  try {
    const event = claudeToEvent({
      hook_event_name: "SubagentStop",
      session_id: "s",
      cwd: "/main-checkout/.claude/worktrees/feature-x",
    });
    assert.equal(event?.projectDir, "/main-checkout");
    assert.equal(event?.cwd, "/main-checkout/.claude/worktrees/feature-x");
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = previous;
    }
  }
});

test("cwd is absent when the raw payload carries none", () => {
  const event = claudeToEvent({ hook_event_name: "SessionStart", session_id: "s" });
  assert.equal(event?.cwd, undefined);
});

test("effort.level maps to the normalized EffortLevel when recognized", () => {
  const event = claudeToEvent({
    hook_event_name: "SubagentStart",
    session_id: "s",
    cwd: "/repo",
    effort: { level: "high" },
  });
  assert.equal(event?.effort, "high");
});

test("effort.level yields undefined when unrecognized", () => {
  const event = claudeToEvent({
    hook_event_name: "SubagentStart",
    session_id: "s",
    cwd: "/repo",
    effort: { level: "turbo" },
  });
  assert.equal(event?.effort, undefined);
});

test("effort is undefined when absent from the payload", () => {
  const event = claudeToEvent(fixture("session-start"));
  assert.equal(event?.effort, undefined);
});

test("transcriptPath is carried through when present", () => {
  const event = claudeToEvent(fixture("session-start"));
  assert.equal(event?.transcriptPath, "/tmp/transcript.jsonl");
});

test("an entirely unknown hook_event_name returns null rather than throwing", () => {
  assert.doesNotThrow(() => claudeToEvent(fixture("unknown-event")));
  assert.equal(claudeToEvent(fixture("unknown-event")), null);
});

test("a missing hook_event_name returns null", () => {
  assert.equal(claudeToEvent({ cwd: "/repo" }), null);
});

test("permission_mode is carried onto the event", () => {
  const event = claudeToEvent({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd: "/tmp",
    session_id: "s1",
    permission_mode: "bypassPermissions",
  });
  assert.equal(event?.permissionMode, "bypassPermissions");
});

test("a payload without permission_mode leaves the field absent rather than defaulting it", () => {
  const event = claudeToEvent({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd: "/tmp",
    session_id: "s1",
  });
  assert.equal(event?.permissionMode, undefined);
});
