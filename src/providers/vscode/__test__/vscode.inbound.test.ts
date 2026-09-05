import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HarnessEvent, HarnessEventKind } from "../../../contracts/index.ts";
import { vscodeToEvent } from "../vscode.inbound.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

function parse(name: string): HarnessEvent {
  const event = vscodeToEvent(fixture(name));
  assert.ok(event, `${name} parsed to null`);
  return event;
}

/** Every fixture in the directory, and the kind design §5 says it fans out to. `null` means deliberately unmapped. */
const EXPECTED_KIND: Record<string, HarnessEventKind | null> = {
  "session-start.json": "session.start",
  "user-prompt-submit.json": "prompt.submit",
  "pre-tool-use-terminal.json": "shell.before",
  "pre-tool-use-terminal-camel.json": "shell.before",
  "pre-tool-use-read.json": "read.before",
  "pre-tool-use-read-snake.json": "read.before",
  "pre-tool-use-edit.json": "tool.before",
  "pre-tool-use-mcp.json": "mcp.before",
  "pre-tool-use-unknown.json": "tool.before",
  "post-tool-use-terminal.json": "shell.after",
  "post-tool-use-edit.json": "edit.after",
  "post-tool-use-create.json": "edit.after",
  "pre-compact.json": "compact.before",
  "subagent-start.json": "subagent.start",
  "subagent-stop.json": "subagent.stop",
  "stop.json": "stop",
  "unknown-event.json": null,
};

test("the table above covers every fixture in the directory, so nothing is silently untested", () => {
  const onDisk = readdirSync(FIXTURES)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(onDisk, Object.keys(EXPECTED_KIND).sort());
});

test("every fixture maps to the kind design §5 gives it", () => {
  for (const [name, kind] of Object.entries(EXPECTED_KIND)) {
    const event = vscodeToEvent(fixture(name));
    assert.equal(event === null ? null : event.event, kind, name);
  }
});

// spec P4 AC3: the same payload in camelCase and in snake_case parses to the same event.
test("the camelCase and VS Code-compatible spellings of one payload produce the same event", () => {
  const snake = parse("pre-tool-use-terminal.json");
  const camel = parse("pre-tool-use-terminal-camel.json");
  const withoutRaw = ({ raw: _raw, ...rest }: HarnessEvent): Omit<HarnessEvent, "raw"> => rest;
  assert.deepEqual(withoutRaw(camel), withoutRaw(snake));
  // the two payloads really are spelled differently, so the assertion above is not comparing a fixture to itself
  assert.notDeepEqual(camel.raw, snake.raw);
});

test("each field the two spellings disagree on survives from the camelCase payload", () => {
  const camel = parse("pre-tool-use-terminal-camel.json");
  assert.equal(camel.event, "shell.before", "hookEventName was read");
  assert.equal(camel.sessionKey, "vscode-vscode-session-0001", "sessionId was read");
  assert.equal(camel.command, "rm -rf /", "toolName and toolArgs were read");
});

test("an unknown tool name falls to the generic kind rather than returning null", () => {
  const before = parse("pre-tool-use-unknown.json");
  assert.equal(before.event, "tool.before");
  assert.equal(before.toolName, "pushToGitHub");
  assert.deepEqual(before.toolInput, { branch: "main" });
});

test("an event name neither source lists returns null rather than a near-enough kind", () => {
  assert.equal(vscodeToEvent(fixture("unknown-event.json")), null);
});

test("a payload with no hook event name at all returns null", () => {
  assert.equal(vscodeToEvent({ cwd: "/repo" }), null);
});

// VS Code's own tool vocabulary, one assertion per row of the design §5 table.
test("runTerminalCommand is the shell tool on both directions", () => {
  assert.equal(parse("pre-tool-use-terminal.json").command, "rm -rf /");
  assert.equal(parse("post-tool-use-terminal.json").event, "shell.after");
});

test("both documented spellings of the read tool map to read.before with the file path", () => {
  assert.equal(parse("pre-tool-use-read.json").filePath, "/repo/.env");
  assert.equal(parse("pre-tool-use-read-snake.json").filePath, "/repo/.env");
});

test("the edit tools map to edit.after carrying the tool name and the file path", () => {
  const replace = parse("post-tool-use-edit.json");
  assert.equal(replace.toolName, "replace_string_in_file");
  assert.equal(replace.filePath, "/repo/src/index.ts");
  const create = parse("post-tool-use-create.json");
  assert.equal(create.toolName, "createFile");
  assert.equal(create.filePath, "/repo/src/new.ts");
});

test("the mcp_ prefix maps to mcp.before carrying the tool name and its arguments", () => {
  const event = parse("pre-tool-use-mcp.json");
  assert.equal(event.event, "mcp.before");
  assert.equal(event.toolName, "mcp_github_create_issue");
  assert.deepEqual(event.toolInput, { title: "flaky test" });
});

/**
 * `editFiles` at `PreToolUse` is a tool about to run, not an edit that happened. Design §5 puts the edit row on
 * the after-direction only, and a before-event routed to `edit.after` would fire an after-rule on work not done.
 */
test("an edit tool before it runs is a generic before-event, not edit.after", () => {
  const event = parse("pre-tool-use-edit.json");
  assert.equal(event.event, "tool.before");
  assert.equal(event.toolName, "editFiles");
});

// invariant from AD-125: `toolOutputAtAfter` is the one output flag this host has, and it is the after-events only.
test("PostToolUse delivers the tool's text result, unwrapped from the tool_result envelope", () => {
  assert.equal(parse("post-tool-use-terminal.json").toolOutput, "2527 passing");
  assert.equal(parse("post-tool-use-edit.json").toolOutput, "edited src/index.ts");
});

test("a before-event carries no tool output", () => {
  assert.equal(parse("pre-tool-use-terminal.json").toolOutput, undefined);
});

/**
 * invariant: `stop_hook_active` is a boolean and `loopCount` is a number the grind cap compares against, so
 * mapping it in would leave the cap unreachable and a grind loop would never stop
 * ([/decisions/ad-125.md](/decisions/ad-125.md)).
 */
test("stop_hook_active never reaches loopCount", () => {
  const raw = fixture("stop.json");
  assert.equal(raw.stop_hook_active, false, "precondition: the fixture carries the field");
  assert.equal(parse("stop.json").loopCount, undefined);
});

/** `stop_reason` is `"end_turn"`, which is not a member of the `completed | aborted | error` vocabulary. */
test("stop_reason never reaches status", () => {
  const raw = fixture("stop.json");
  assert.equal(raw.stop_reason, "end_turn", "precondition: the fixture carries the field");
  assert.equal(parse("stop.json").status, undefined);
});

test("every event is stamped with the vscode provider and a session key derived from the session id", () => {
  for (const name of Object.keys(EXPECTED_KIND)) {
    if (EXPECTED_KIND[name] === null) {
      continue;
    }
    const event = parse(name);
    assert.equal(event.provider, "vscode", name);
    assert.equal(event.sessionKey, "vscode-vscode-session-0001", name);
    assert.equal(event.projectDir, "/repo", name);
  }
});

test("the raw payload is left untouched, because the renderer reads the hook name back off it", () => {
  const raw = fixture("pre-tool-use-terminal.json");
  assert.deepEqual(parse("pre-tool-use-terminal.json").raw, raw);
});

/**
 * The host's own name for a spawn is a label, never a type to match against: `agent_type` on the stop is the same
 * string the spawn chose ([/decisions/ad-104.md](/decisions/ad-104.md)).
 */
test("a subagent's name lands in the label and no declared type is invented", () => {
  const stop = parse("subagent-stop.json");
  assert.equal(stop.spawnAgentLabel, "explore");
  assert.equal(stop.spawnSubagentType, undefined);
  assert.equal(parse("subagent-start.json").spawnAgentLabel, "explore");
});
