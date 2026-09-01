import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { presenceDir } from "../../../platform/paths.ts";
import { sanitizeSegment } from "../../../platform/sanitize.ts";
import {
  checkCollision,
  heartbeat,
  isSessionLive,
  listPresenceRecords,
  presenceSessionKey,
  readPresenceRecord,
  register,
  release,
  sweepStale,
} from "../presence.service.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-presence-"));
}

test("register writes a presence record with every required field", () => {
  const root = tempRoot();
  try {
    const record = register(root, { provider: "provider-a", session: "session-a", pid: 111, branch: "main" });
    assert.equal(record.provider, "provider-a");
    assert.equal(record.session, "session-a");
    assert.equal(record.pid, 111);
    assert.equal(record.branch, "main");
    assert.equal(record.started_at, record.heartbeat_at);
    assert.deepEqual(record.recent_files, []);
    assert.deepEqual(readPresenceRecord(root, "provider-a", "session-a"), record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat refreshes heartbeat_at", () => {
  const root = tempRoot();
  try {
    register(root, {
      provider: "provider-a",
      session: "session-a",
      pid: 1,
      branch: "main",
      now: new Date(0),
    });
    const updated = heartbeat(root, { provider: "provider-a", session: "session-a", now: new Date(60_000) });
    assert.equal(updated?.heartbeat_at, new Date(60_000).toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat appends a touched file to recent_files", () => {
  const root = tempRoot();
  try {
    register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
    const updated = heartbeat(root, { provider: "provider-a", session: "session-a", file: "src/x.ts" });
    assert.deepEqual(updated?.recent_files, ["src/x.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat bounds recent_files to a fixed length without duplicating a re-touched file", () => {
  const root = tempRoot();
  try {
    register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
    for (let i = 0; i < 25; i++) {
      heartbeat(root, { provider: "provider-a", session: "session-a", file: `src/file-${i}.ts` });
    }
    heartbeat(root, { provider: "provider-a", session: "session-a", file: "src/file-24.ts" });
    const record = readPresenceRecord(root, "provider-a", "session-a");
    assert.ok((record?.recent_files.length ?? 0) <= 20);
    const occurrences = record?.recent_files.filter((f) => f === "src/file-24.ts").length;
    assert.equal(occurrences, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * why this must self-heal: a "no-such" session is exactly what a genuinely-live session looks like the moment
 * after `sweepStale` deletes its record — the fixed defect found by review was that a no-op left it
 * permanently misdiagnosed as dead, since nothing else ever re-creates the file.
 */
test("heartbeat on a session with no existing record creates a fresh, live one", () => {
  const root = tempRoot();
  try {
    const created = heartbeat(root, {
      provider: "provider-a",
      session: "no-such",
      now: new Date("2026-07-29T10:00:00.000Z"),
    });
    assert.equal(created.provider, "provider-a");
    assert.equal(created.session, "no-such");
    assert.equal(created.heartbeat_at, "2026-07-29T10:00:00.000Z");
    assert.deepEqual(readPresenceRecord(root, "provider-a", "no-such"), created);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** AD-122 — the exact repro review found: a session swept for going ten-plus minutes quiet is not dead, and
 * its own next heartbeat must undo the sweep rather than leave it permanently unreadable as live. */
test("a session swept for going quiet becomes live again on its own next heartbeat", () => {
  const root = tempRoot();
  try {
    register(root, {
      provider: "provider-a",
      session: "session-a",
      pid: 1,
      branch: "main",
      now: new Date("2026-07-29T10:00:00.000Z"),
    });
    const afterSweep = new Date("2026-07-29T10:35:00.000Z");
    assert.equal(sweepStale(root, afterSweep), 1, "quiet past the conversation window is swept");
    assert.equal(isSessionLive(root, "provider-a", "session-a", afterSweep), false);

    heartbeat(root, { provider: "provider-a", session: "session-a", now: afterSweep });
    assert.equal(isSessionLive(root, "provider-a", "session-a", afterSweep), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** why this must not use checkCollision's shorter window: fifteen quiet minutes is an operator reading long
 * output, not a conversation that ended — the exact misdiagnosis a second review pass reproduced against ten
 * minutes ([/decisions/ad-122.md](/decisions/ad-122.md)). `isSessionLive` deciding whether a predecessor's
 * continuity leaks into another session is the one call site this AD exists to get right. */
test("isSessionLive tolerates a session quiet longer than the file-claim window but not the conversation window", () => {
  const root = tempRoot();
  try {
    register(root, {
      provider: "provider-a",
      session: "session-a",
      pid: 1,
      branch: "main",
      now: new Date("2026-07-29T10:00:00.000Z"),
    });
    assert.equal(
      isSessionLive(root, "provider-a", "session-a", new Date("2026-07-29T10:15:00.000Z")),
      true,
      "fifteen quiet minutes exceeds the ten-minute claim window but not the thirty",
    );
    assert.equal(
      isSessionLive(root, "provider-a", "session-a", new Date("2026-07-29T10:31:00.000Z")),
      false,
      "thirty-one quiet minutes exceeds the conversation window",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCollision asks and names the foreign provider, session, and elapsed time", () => {
  const root = tempRoot();
  try {
    const start = new Date("2026-07-29T10:00:00.000Z");
    register(root, { provider: "provider-b", session: "session-b", pid: 2, branch: "main", now: start });
    heartbeat(root, { provider: "provider-b", session: "session-b", file: "src/shared.ts", now: start });
    const decision = checkCollision(
      root,
      "src/shared.ts",
      presenceSessionKey("provider-a", "session-a"),
      new Date("2026-07-29T10:03:00.000Z"),
    );
    assert.equal(decision.kind, "ask");
    if (decision.kind === "ask") {
      assert.match(decision.reason, /provider-b/);
      assert.match(decision.reason, /session-b/);
      assert.match(decision.userNote ?? "", /minutes ago|just now/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record belonging to the current session never collides with itself", () => {
  const root = tempRoot();
  try {
    register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
    heartbeat(root, { provider: "provider-a", session: "session-a", file: "src/shared.ts" });
    const decision = checkCollision(root, "src/shared.ts", presenceSessionKey("provider-a", "session-a"));
    assert.equal(decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign record older than 10 minutes is ignored for collision checks", () => {
  const root = tempRoot();
  try {
    const start = new Date("2026-07-29T10:00:00.000Z");
    register(root, { provider: "provider-b", session: "session-b", pid: 2, branch: "main", now: start });
    heartbeat(root, { provider: "provider-b", session: "session-b", file: "src/shared.ts", now: start });
    const decision = checkCollision(
      root,
      "src/shared.ts",
      presenceSessionKey("provider-a", "session-a"),
      new Date("2026-07-29T10:21:00.000Z"),
    );
    assert.equal(decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCollision allows when no live record lists the file at all", () => {
  const root = tempRoot();
  try {
    register(root, { provider: "provider-b", session: "session-b", pid: 2, branch: "main" });
    const decision = checkCollision(root, "src/untouched.ts", presenceSessionKey("provider-a", "session-a"));
    assert.equal(decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepStale deletes only expired records", () => {
  const root = tempRoot();
  try {
    register(root, {
      provider: "provider-a",
      session: "session-a",
      pid: 1,
      branch: "main",
      now: new Date("2026-07-29T10:00:00.000Z"),
    });
    register(root, {
      provider: "provider-b",
      session: "session-b",
      pid: 2,
      branch: "main",
      now: new Date("2026-07-29T10:29:00.000Z"),
    });
    const swept = sweepStale(root, new Date("2026-07-29T10:31:00.000Z"));
    assert.equal(swept, 1);
    assert.equal(readPresenceRecord(root, "provider-a", "session-a"), null);
    assert.ok(readPresenceRecord(root, "provider-b", "session-b"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** why this must not use checkCollision's shorter window: a conversation that has simply gone quiet for
 * longer than a file-edit claim survives is not the same fact as one that has ended — sweeping it away on the
 * claim window's timing would make `isSessionLive` disagree with the record's own continued existence. */
test("sweepStale tolerates a record quiet longer than the file-claim window but not the conversation window", () => {
  const root = tempRoot();
  try {
    register(root, {
      provider: "provider-a",
      session: "session-a",
      pid: 1,
      branch: "main",
      now: new Date("2026-07-29T10:00:00.000Z"),
    });
    const swept = sweepStale(root, new Date("2026-07-29T10:15:00.000Z"));
    assert.equal(swept, 0, "fifteen quiet minutes exceeds the ten-minute claim window but not the thirty");
    assert.ok(readPresenceRecord(root, "provider-a", "session-a"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepStale leaves live records untouched and reports zero swept", () => {
  const root = tempRoot();
  try {
    register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
    assert.equal(sweepStale(root), 0);
    assert.ok(readPresenceRecord(root, "provider-a", "session-a"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release deletes only the current session's record", () => {
  const root = tempRoot();
  try {
    register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
    register(root, { provider: "provider-b", session: "session-b", pid: 2, branch: "main" });
    release(root, "provider-a", "session-a");
    assert.equal(readPresenceRecord(root, "provider-a", "session-a"), null);
    assert.ok(readPresenceRecord(root, "provider-b", "session-b"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("presence filenames pass the platform sanitizer even for a session id with unsafe characters", () => {
  const root = tempRoot();
  try {
    register(root, { provider: "provider-a", session: "weird:session/id", pid: 1, branch: "main" });
    const files = readdirSync(presenceDir(root));
    assert.equal(files.length, 1);
    assert.equal(files[0], `${sanitizeSegment(presenceSessionKey("provider-a", "weird:session/id"))}.json`);
    assert.ok(readPresenceRecord(root, "provider-a", "weird:session/id"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-registering a session overwrites its prior record cleanly", () => {
  const root = tempRoot();
  try {
    register(root, {
      provider: "provider-a",
      session: "session-a",
      pid: 1,
      branch: "main",
      now: new Date("2026-07-29T09:00:00.000Z"),
    });
    heartbeat(root, { provider: "provider-a", session: "session-a", file: "src/old.ts" });
    const fresh = register(root, {
      provider: "provider-a",
      session: "session-a",
      pid: 2,
      branch: "feature",
      now: new Date("2026-07-29T10:00:00.000Z"),
    });
    assert.deepEqual(fresh.recent_files, []);
    assert.equal(fresh.branch, "feature");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listPresenceRecords aggregates records across multiple sessions", () => {
  const root = tempRoot();
  try {
    register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
    register(root, { provider: "provider-b", session: "session-b", pid: 2, branch: "main" });
    const records = listPresenceRecords(root);
    assert.equal(records.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release on a session that was never registered does not throw", () => {
  const root = tempRoot();
  try {
    assert.doesNotThrow(() => release(root, "provider-a", "never-registered"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
