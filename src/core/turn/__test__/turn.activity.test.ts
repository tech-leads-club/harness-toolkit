import assert from "node:assert/strict";
import { test } from "node:test";
import { activitySince, endedWithoutActing } from "../turn.activity.ts";

// why: the window boundary is a timestamp now, because the events counted inside it come from two planes and
// two files cannot share an index. Each call gets a later `ts` so the order in the array is the order in time.
let clock = 0;
function event(kind: string, session = "provider-a-s1"): Record<string, unknown> {
  clock += 1;
  return {
    schema: "harness.observability.v1",
    kind,
    session_id: session,
    level: "signal",
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
  };
}

test("counts only tool events after the last prompt in this session", () => {
  const events = [
    event("prompt.submit"),
    event("tool.start"),
    event("prompt.submit"),
    event("tool.start"),
    event("shell.end"),
  ] as never[];
  const activity = activitySince(events, "provider-a-s1");
  assert.equal(activity.sawTurnStart, true);
  assert.equal(activity.toolCalls, 2);
});

test("another session's tool calls never count toward this one", () => {
  const events = [
    event("prompt.submit", "provider-a-s1"),
    event("tool.start", "provider-b-s9"),
    event("shell.end", "provider-b-s9"),
  ] as never[];
  assert.equal(activitySince(events, "provider-a-s1").toolCalls, 0);
});

test("a turn with no prompt boundary reports it rather than guessing", () => {
  const activity = activitySince([event("tool.start")] as never[], "provider-a-s1");
  assert.equal(activity.sawTurnStart, false);
});

test("open work with no tool call and no diff is an idle turn", () => {
  assert.equal(
    endedWithoutActing({
      activity: { toolCalls: 0, sawTurnStart: true },
      changedFiles: 0,
      hasOpenWork: true,
    }),
    true,
  );
});

test("a single tool call is enough to clear the gate", () => {
  assert.equal(
    endedWithoutActing({
      activity: { toolCalls: 1, sawTurnStart: true },
      changedFiles: 0,
      hasOpenWork: true,
    }),
    false,
  );
});

test("a file change clears the gate even with no recorded tool call", () => {
  assert.equal(
    endedWithoutActing({
      activity: { toolCalls: 0, sawTurnStart: true },
      changedFiles: 3,
      hasOpenWork: true,
    }),
    false,
  );
});

test("no open work means an empty turn is legitimate", () => {
  assert.equal(
    endedWithoutActing({
      activity: { toolCalls: 0, sawTurnStart: true },
      changedFiles: 0,
      hasOpenWork: false,
    }),
    false,
  );
});

test("without a prompt boundary the gate abstains rather than false-blocking", () => {
  assert.equal(
    endedWithoutActing({
      activity: { toolCalls: 0, sawTurnStart: false },
      changedFiles: 0,
      hasOpenWork: true,
    }),
    false,
  );
});

/**
 * hazard: the counter read `obs.jsonl` alone, and a tool call that succeeds resolves to the debug plane. Measured
 * on the harness's own state: 0 `tool.end` in the signal plane against 322 in the debug plane. So the count was
 * zero for every turn whose work went well, and the operator saw the same BLOCKED four times in a row
 * ([/decisions/ad-059.md](/decisions/ad-059.md)).
 */
test("the kinds a successful turn actually produces are counted", () => {
  for (const kind of ["tool.end", "shell.end", "file.edit", "file.read", "mcp.end"]) {
    const events = [event("prompt.submit"), event(kind)] as never[];
    assert.equal(activitySince(events, "provider-a-s1").toolCalls, 1, kind);
  }
});

test("both planes are read, since neither alone answers the question", async () => {
  const { ACTIVITY_PLANES } = await import("../turn.activity.ts");
  assert.deepEqual([...ACTIVITY_PLANES], ["obs.jsonl", "debug.jsonl"]);
});

// why: the two planes arrive concatenated rather than interleaved, so an event from the second file can sit
// before the boundary in array order while being after it in time.
test("an out-of-order plane still lands inside its own turn", () => {
  const boundary = event("prompt.submit");
  const work = event("shell.end");
  const stale = { ...event("shell.end"), ts: "2020-01-01T00:00:00.000Z" };
  const events = [work, stale, boundary] as never[];
  assert.equal(activitySince(events, "provider-a-s1").toolCalls, 1);
});
