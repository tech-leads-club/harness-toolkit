import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { presenceDir } from "../../../platform/paths.ts";
import { sanitizeSegment } from "../../../platform/sanitize.ts";
import {
  checkCollision,
  filesClaimedByOtherLiveSessions,
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

/**
 * AD-137 (round 2) — the reported symptom's actual mechanism: two sessions in the same checkout both see the
 * same shared git working tree, so a file only one of them touched still shows up in the other's own diff.
 * `filesClaimedByOtherLiveSessions` is what a caller subtracts from that diff before scoping a gate to it.
 */
describe("filesClaimedByOtherLiveSessions", () => {
  /**
   * why an absolute path here, not a relative one: a Verifier caught round 2 shipping inert in production —
   * `run.ts` writes `event.filePath` verbatim, and every real host sends an absolute path, while
   * `changedFiles` (`git diff --name-only`) is repo-relative. A test claiming the relative form the same way
   * `changedFiles` already does would pass by coincidence and never catch that mismatch again
   * ([/decisions/ad-137.md](/decisions/ad-137.md)).
   */
  function gitRoot(): string {
    return tempRoot();
  }

  test("a live neighbour's own claimed file is returned, normalized to the git-relative form changedFiles uses", () => {
    const root = tempRoot();
    const repo = gitRoot();
    try {
      register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
      heartbeat(root, {
        provider: "provider-a",
        session: "session-a",
        file: join(repo, "src/app.ts"),
      });

      const claimed = filesClaimedByOtherLiveSessions(root, repo, "provider-a", "session-b");

      assert.ok(
        claimed.has("src/app.ts"),
        "session B must see session A's own claim, in changedFiles's own shape",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("this session's own claimed file is never returned, even if it also appears in a neighbour's claims", () => {
    const root = tempRoot();
    const repo = gitRoot();
    try {
      register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
      heartbeat(root, { provider: "provider-a", session: "session-a", file: join(repo, "src/shared.ts") });
      register(root, { provider: "provider-a", session: "session-b", pid: 2, branch: "main" });
      heartbeat(root, { provider: "provider-a", session: "session-b", file: join(repo, "src/shared.ts") });

      const claimed = filesClaimedByOtherLiveSessions(root, repo, "provider-a", "session-b");

      assert.equal(
        claimed.has("src/shared.ts"),
        false,
        "a file both sessions touched must not be excluded from either one's own scope",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an unclaimed file (no session's own recent_files names it) is never returned", () => {
    const root = tempRoot();
    const repo = gitRoot();
    try {
      register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
      heartbeat(root, { provider: "provider-a", session: "session-a", file: join(repo, "src/app.ts") });

      const claimed = filesClaimedByOtherLiveSessions(root, repo, "provider-a", "session-b");

      assert.equal(
        claimed.has("src/generated.ts"),
        false,
        "a file no presence record claims (a shell script, a generated output) must stay in scope for everyone",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a stale (not live) neighbour's claim is never returned", () => {
    const root = tempRoot();
    const repo = gitRoot();
    try {
      const start = new Date("2026-07-29T10:00:00.000Z");
      register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main", now: start });
      heartbeat(root, {
        provider: "provider-a",
        session: "session-a",
        file: join(repo, "src/app.ts"),
        now: start,
      });

      const later = new Date("2026-07-29T10:35:00.000Z");
      const claimed = filesClaimedByOtherLiveSessions(root, repo, "provider-a", "session-b", later);

      assert.equal(
        claimed.has("src/app.ts"),
        false,
        "a session gone quiet past the conversation window is not a live source to exclude on behalf of",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a different provider's own live session is still a source — the check is not provider-scoped", () => {
    const root = tempRoot();
    const repo = gitRoot();
    try {
      register(root, { provider: "provider-b", session: "session-x", pid: 1, branch: "main" });
      heartbeat(root, { provider: "provider-b", session: "session-x", file: join(repo, "src/app.ts") });

      const claimed = filesClaimedByOtherLiveSessions(root, repo, "provider-a", "session-a");

      assert.ok(claimed.has("src/app.ts"), "the shared working tree has no provider boundary either");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("with no other presence records at all, nothing is claimed — the common, single-session case", () => {
    const root = tempRoot();
    const repo = gitRoot();
    try {
      const claimed = filesClaimedByOtherLiveSessions(root, repo, "provider-a", "session-a");
      assert.equal(claimed.size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a file already claimed in its relative form (no host ever sends one, but never assume) still matches", () => {
    const root = tempRoot();
    const repo = gitRoot();
    try {
      register(root, { provider: "provider-a", session: "session-a", pid: 1, branch: "main" });
      heartbeat(root, { provider: "provider-a", session: "session-a", file: "src/app.ts" });

      const claimed = filesClaimedByOtherLiveSessions(root, repo, "provider-a", "session-b");

      assert.ok(
        claimed.has("src/app.ts"),
        "a relative claim passes through unchanged, not just an absolute one",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
