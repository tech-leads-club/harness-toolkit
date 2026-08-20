import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectStateDir } from "../../platform/paths.ts";
import { CONTEXT_BUDGET_CHARS, claimsFile, runHandler } from "../run.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-run-"));
}

function obsRecords(root: string): Array<Record<string, unknown>> {
  const path = join(projectStateDir(root), "obs.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

function cursorPayload(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "preToolUse",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    tool_name: "Read",
    ...overrides,
  };
}

function claudePayload(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Grep",
    ...overrides,
  };
}

test("empty stdin yields abstain with no stdout and exit 0", async () => {
  const root = tempRoot();
  try {
    const outcome = await withCwd(root, () => runHandler(() => ({ kind: "allow" }), stdinOf("")));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, null);
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty stdin records one adapter.unrecognized obs entry", async () => {
  const root = tempRoot();
  try {
    await withCwd(root, () => runHandler(() => ({ kind: "allow" }), stdinOf("   ")));
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "adapter.unrecognized");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-JSON stdin yields abstain and exit 0", async () => {
  const root = tempRoot();
  try {
    const outcome = await withCwd(root, () => runHandler(() => ({ kind: "allow" }), stdinOf("{ not json")));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-JSON stdin records one adapter.unrecognized obs entry", async () => {
  const root = tempRoot();
  try {
    await withCwd(root, () => runHandler(() => ({ kind: "allow" }), stdinOf("not json at all")));
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "adapter.unrecognized");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a payload matching no provider yields abstain", async () => {
  const root = tempRoot();
  try {
    const outcome = await withCwd(root, () =>
      runHandler(() => ({ kind: "allow" }), stdinOf(JSON.stringify({ foo: "bar" }))),
    );
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a payload matching no provider records one adapter.unrecognized obs entry", async () => {
  const root = tempRoot();
  try {
    await withCwd(root, () => runHandler(() => ({ kind: "allow" }), stdinOf(JSON.stringify({ foo: "bar" }))));
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "adapter.unrecognized");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a detected provider with an unrecognized hook event yields abstain and logs the provider name", async () => {
  const root = tempRoot();
  try {
    const payload = cursorPayload(root, { hook_event_name: "notARealHook" });
    const outcome = await withCwd(root, () =>
      runHandler(() => ({ kind: "allow" }), stdinOf(JSON.stringify(payload))),
    );
    assert.equal(outcome.decision.kind, "abstain");
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "adapter.unrecognized");
    assert.equal((records[0]?.attrs as Record<string, unknown>)?.provider, "cursor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a handler that throws yields abstain and exit code 0, never 2", async () => {
  const root = tempRoot();
  try {
    const payload = cursorPayload(root);
    const outcome = await runHandler(
      () => {
        throw new Error("boom");
      },
      stdinOf(JSON.stringify(payload)),
    );
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.exitCode, 0);
    assert.notEqual(outcome.rendered.exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a handler that throws records one adapter.error obs entry naming the provider and event", async () => {
  const root = tempRoot();
  try {
    const payload = cursorPayload(root);
    await runHandler(
      () => {
        throw new Error("boom");
      },
      stdinOf(JSON.stringify(payload)),
    );
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "adapter.error");
    const attrs = records[0]?.attrs as Record<string, unknown>;
    assert.equal(attrs.provider, "cursor");
    assert.equal(attrs.event, "tool.before");
    assert.match(String(attrs.message), /boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ask decision at tool.before degrades to deny with the escalation prefix under Cursor", async () => {
  const root = tempRoot();
  try {
    const payload = cursorPayload(root);
    const outcome = await runHandler(
      () => ({ kind: "ask", reason: "confirm first", rule: "test-ask" }),
      stdinOf(JSON.stringify(payload)),
    );
    assert.equal(outcome.decision.kind, "deny");
    if (outcome.decision.kind === "deny") {
      assert.match(outcome.decision.reason, /^Escalation unavailable on this provider — /);
    }
    assert.match(String(outcome.rendered.stdout), /"permission":"deny"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ask decision at tool.before stays ask under Claude, which supports it", async () => {
  const root = tempRoot();
  try {
    const payload = claudePayload(root);
    const outcome = await runHandler(
      () => ({ kind: "ask", reason: "confirm first", rule: "test-ask" }),
      stdinOf(JSON.stringify(payload)),
    );
    assert.equal(outcome.decision.kind, "ask");
    assert.match(String(outcome.rendered.stdout), /"permissionDecision":"ask"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("presence heartbeat fires for a recognized event and refreshes heartbeat_at", async () => {
  const root = tempRoot();
  try {
    coreFacade.presence.register(root, {
      provider: "cursor",
      session: "conv-1",
      pid: 1,
      branch: "main",
      now: new Date("2026-07-29T10:00:00.000Z"),
    });
    const payload = cursorPayload(root);
    await runHandler(() => ({ kind: "allow" }), {
      ...stdinOf(JSON.stringify(payload)),
      now: () => new Date("2026-07-29T10:05:00.000Z"),
    });
    const { readPresenceRecord } = await import("../../core/presence/presence.service.ts");
    const updated = readPresenceRecord(root, "cursor", "conv-1");
    assert.equal(updated?.heartbeat_at, new Date("2026-07-29T10:05:00.000Z").toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: this test asserted the opposite — that a `read.before` records the file — and that is the defect. A read
 * claimed the file for ten minutes, so a second session was refused a write under a rule called `edit-collision`,
 * with a message asserting an edit. Measured on a real machine: a review agent that only read blocked the
 * operator's own writes to two files ([/decisions/ad-099.md](/decisions/ad-099.md)).
 *
 * invariant: a reader loses nothing, so it claims nothing. The heartbeat still moves, because a reading session is
 * still alive and staleness is what expires a claim.
 */
test("AC1 a read claims no file, and AC3 still keeps the session alive", async () => {
  const root = tempRoot();
  try {
    coreFacade.presence.register(root, { provider: "cursor", session: "conv-1", pid: 1, branch: "main" });
    const payload = {
      hook_event_name: "beforeReadFile",
      workspace_roots: [root],
      conversation_id: "conv-1",
      session_id: "sess-1",
      file_path: "src/read-only.ts",
    };

    await runHandler(() => ({ kind: "allow" }), {
      ...stdinOf(JSON.stringify(payload)),
      now: () => new Date("2026-08-20T10:05:00.000Z"),
    });

    const { readPresenceRecord } = await import("../../core/presence/presence.service.ts");
    const updated = readPresenceRecord(root, "cursor", "conv-1");
    assert.deepEqual(updated?.recent_files, [], "reading is not claiming");
    assert.equal(
      updated?.heartbeat_at,
      new Date("2026-08-20T10:05:00.000Z").toISOString(),
      "the session is still live",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC2 a write claims the file it wrote", async () => {
  const root = tempRoot();
  try {
    coreFacade.presence.register(root, { provider: "cursor", session: "conv-1", pid: 1, branch: "main" });
    const payload = {
      hook_event_name: "afterFileEdit",
      workspace_roots: [root],
      conversation_id: "conv-1",
      session_id: "sess-1",
      file_path: "src/written.ts",
    };

    await runHandler(() => ({ kind: "allow" }), stdinOf(JSON.stringify(payload)));

    const { readPresenceRecord } = await import("../../core/presence/presence.service.ts");
    assert.deepEqual(readPresenceRecord(root, "cursor", "conv-1")?.recent_files, ["src/written.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** invariant: the decision is the tool, not the path. A read tool carrying a path is still a read. */
test("AC1 a read tool that carries a path claims nothing, and a write tool claims", () => {
  const base = {
    provider: "claude",
    sessionKey: "claude:sess-1",
    projectDir: "/tmp/x",
    filePath: "src/thing.ts",
    raw: {},
  } as const;

  assert.equal(claimsFile({ ...base, event: "tool.before", toolName: "Read" }), false);
  assert.equal(claimsFile({ ...base, event: "read.before" }), false);
  assert.equal(claimsFile({ ...base, event: "tool.before", toolName: "Grep" }), false);
  assert.equal(claimsFile({ ...base, event: "tool.before", toolName: "Edit" }), true);
  assert.equal(claimsFile({ ...base, event: "tool.before", toolName: "Write" }), true);
  assert.equal(claimsFile({ ...base, event: "edit.after" }), true, "a completed edit is a write");
  assert.equal(
    claimsFile({ provider: "claude", sessionKey: "k", projectDir: "/tmp/x", raw: {}, event: "edit.after" }),
    false,
    "no path, no claim",
  );
});

test("a context decision over the session budget is truncated with the trailing marker", async () => {
  const root = tempRoot();
  try {
    const payload = {
      hook_event_name: "sessionStart",
      workspace_roots: [root],
      conversation_id: "conv-1",
      session_id: "sess-1",
    };
    const longText = "A".repeat(CONTEXT_BUDGET_CHARS + 1000);
    const outcome = await runHandler(
      () => ({ kind: "context", text: longText }),
      stdinOf(JSON.stringify(payload)),
    );
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.ok(outcome.decision.text.length < longText.length);
      assert.match(outcome.decision.text, /truncated — over context budget/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an allow decision renders the provider's exact allow output", async () => {
  const root = tempRoot();
  try {
    const payload = cursorPayload(root);
    const outcome = await runHandler(() => ({ kind: "allow" }), stdinOf(JSON.stringify(payload)));
    assert.equal(outcome.decision.kind, "allow");
    assert.equal(outcome.rendered.stdout, '{"permission":"allow"}');
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
