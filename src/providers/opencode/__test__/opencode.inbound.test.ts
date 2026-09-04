import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HarnessEventKind } from "../../../contracts/index.ts";
import { opencodeToEvent } from "../opencode.inbound.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(generation: "legacy" | "namespaced", name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, generation, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

const LEGACY_EXPECTED: Record<string, HarnessEventKind> = {
  "tool-execute-before-bash": "shell.before",
  "tool-execute-before-read": "read.before",
  "tool-execute-before-mcp": "mcp.before",
  "tool-execute-before-edit": "tool.before",
  "tool-execute-before-unknown": "tool.before",
  "tool-execute-after-bash": "shell.after",
  "tool-execute-after-write": "edit.after",
  "tool-execute-after-patch": "edit.after",
};

const NAMESPACED_EXPECTED: Record<string, HarnessEventKind> = {
  "tool-execute-before-bash": "shell.before",
  "tool-execute-before-read": "read.before",
  "tool-execute-before-mcp": "mcp.before",
  "tool-execute-before-unknown": "tool.before",
  "tool-execute-after-bash": "shell.after",
  "tool-execute-after-error": "shell.after",
  "shell-create-before": "shell.before",
};

test("every legacy fixture maps to its expected kind", () => {
  for (const [name, kind] of Object.entries(LEGACY_EXPECTED)) {
    assert.equal(opencodeToEvent(fixture("legacy", name))?.event, kind, name);
  }
});

test("every namespaced fixture maps to its expected kind", () => {
  for (const [name, kind] of Object.entries(NAMESPACED_EXPECTED)) {
    assert.equal(opencodeToEvent(fixture("namespaced", name))?.event, kind, name);
  }
});

test("the generation stamp decides the provider name, so one parser serves both adapters", () => {
  assert.equal(opencodeToEvent(fixture("legacy", "tool-execute-before-bash"))?.provider, "opencode-legacy");
  assert.equal(
    opencodeToEvent(fixture("namespaced", "tool-execute-before-bash"))?.provider,
    "opencode-namespaced",
  );
});

test("an unrecognized tool falls to the generic kind on both generations rather than returning null", () => {
  for (const generation of ["legacy", "namespaced"] as const) {
    const before = opencodeToEvent(fixture(generation, "tool-execute-before-unknown"));
    assert.equal(before?.event, "tool.before", generation);
    assert.equal(before?.toolName, "todowrite", generation);
  }
  const after = opencodeToEvent({
    provider: "opencode",
    pluginApi: "namespaced",
    hook: "tool.execute.after",
    sessionID: "ses_1",
    tool: "todowrite",
  });
  assert.equal(after?.event, "tool.after");
});

// why: the tools reference names `apply_patch` where the fixtures and the fan-out table say `patch`. Both are
// documented spellings of the same tool, and mapping only one would send half the edits to the generic kind.
test("both patch spellings map to edit.after", () => {
  for (const tool of ["patch", "apply_patch"]) {
    const event = opencodeToEvent({
      provider: "opencode",
      pluginApi: "legacy",
      hook: "tool.execute.after",
      sessionID: "ses_1",
      tool,
      args: { filePath: "/repo/src/index.ts" },
    });
    assert.equal(event?.event, "edit.after", tool);
    assert.equal(event?.filePath, "/repo/src/index.ts", tool);
  }
});

test("the shell hook maps without going through the tool fan-out and carries command and cwd", () => {
  const event = opencodeToEvent(fixture("namespaced", "shell-create-before"));
  assert.equal(event?.event, "shell.before");
  assert.equal(event?.toolName, undefined, "there is no tool on this hook to name");
  assert.equal(event?.command, "rm -rf /");
  assert.equal(event?.cwd, "/repo");
});

test("a shell tool call carries the command out of args", () => {
  const event = opencodeToEvent(fixture("legacy", "tool-execute-before-bash"));
  assert.equal(event?.command, "rm -rf /");
  assert.deepEqual(event?.toolInput, { command: "rm -rf /" });
});

test("execute.after carries opencode's own status values, and nothing else", () => {
  assert.equal(opencodeToEvent(fixture("namespaced", "tool-execute-after-error"))?.status, "error");
  assert.equal(opencodeToEvent(fixture("namespaced", "tool-execute-after-bash"))?.status, "completed");
  assert.equal(opencodeToEvent(fixture("legacy", "tool-execute-after-bash"))?.status, undefined);
  const aborted = opencodeToEvent({
    provider: "opencode",
    pluginApi: "namespaced",
    hook: "tool.execute.after",
    sessionID: "ses_1",
    tool: "bash",
    status: "aborted",
  });
  assert.equal(aborted?.status, undefined, "opencode documents completed and error only");
});

/**
 * hazard: the ask channel is only answerable if the rule knows what is being asked about. An unstamped
 * `permission.evaluate` is left unmapped rather than raised as a `tool.before` no rule can match on.
 */
test("permission.evaluate is unmapped without a tool, and fans out with one", () => {
  assert.equal(opencodeToEvent(fixture("namespaced", "permission-evaluate")), null);
  const stamped = opencodeToEvent({
    provider: "opencode",
    pluginApi: "namespaced",
    hook: "permission.evaluate",
    sessionID: "ses_1",
    tool: "bash",
    effect: "ask",
  });
  assert.equal(stamped?.event, "shell.before");
});

test("the session key is the host's, not the adapter's, so switching generation keeps one session", () => {
  const legacy = opencodeToEvent(fixture("legacy", "tool-execute-before-bash"));
  const namespaced = opencodeToEvent(fixture("namespaced", "tool-execute-before-bash"));
  assert.equal(legacy?.sessionKey, "opencode-ses_7f3a2b");
  assert.equal(legacy?.sessionKey, namespaced?.sessionKey);
});

test("a payload without the envelope is rejected rather than parsed into a half-empty event", () => {
  for (const raw of [
    { hook: "tool.execute.before", tool: "bash" },
    { provider: "opencode", hook: "tool.execute.before" },
    { provider: "opencode", pluginApi: "v3", hook: "tool.execute.before" },
    { provider: "claude", pluginApi: "legacy", hook: "tool.execute.before" },
    { provider: "opencode", pluginApi: "legacy" },
  ]) {
    assert.equal(opencodeToEvent(raw), null, JSON.stringify(raw));
  }
});

test("an unknown hook returns null rather than a guessed kind", () => {
  const event = opencodeToEvent({
    provider: "opencode",
    pluginApi: "legacy",
    hook: "session.idle",
    sessionID: "ses_1",
  });
  assert.equal(event, null);
});

test("the raw payload is carried through untouched for the adapter's own use", () => {
  const raw = fixture("legacy", "tool-execute-before-bash");
  assert.deepEqual(opencodeToEvent(raw)?.raw, raw);
});
