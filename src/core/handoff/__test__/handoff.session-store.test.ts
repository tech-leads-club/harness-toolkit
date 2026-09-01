import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  findDeadPredecessor,
  latestSessionForProvider,
  patchHandoffSession,
  pruneDeadHandoffSessions,
  readHandoffSessionFile,
} from "../handoff.session-store.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-handoff-session-store-"));
}

function throwing(code: string): (pid: number) => void {
  return () => {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    throw error;
  };
}

const ALIVE = () => undefined;
const DEAD = throwing("ESRCH");

/** Rewrites a session file's owner in place, bypassing `patchHandoffSession`'s own restamp-on-write —
 * the only way to construct a fixture with a specific, chosen `updated_at`/`pid` after the fact. */
async function writeOwnerFields(
  root: string,
  sessionKey: string,
  fields: Partial<{ pid: number; updatedAt: string }>,
): Promise<void> {
  const { handoffSessionPath } = await import("../handoff.session-store.ts");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const path = handoffSessionPath(root, sessionKey);
  const file = JSON.parse(readFileSync(path, "utf8"));
  if (fields.pid !== undefined) {
    file.owner.pid = fields.pid;
  }
  if (fields.updatedAt !== undefined) {
    file.owner.updated_at = fields.updatedAt;
    file.slice.updated_at = fields.updatedAt;
  }
  writeFileSync(path, JSON.stringify(file));
}

describe("patchHandoffSession / readHandoffSessionFile", () => {
  test("round-trips a slice and stamps the owner", async () => {
    const root = tempRoot();
    try {
      const written = await patchHandoffSession(root, "provider-a", "session-1", {
        next_action: "run tests",
      });
      assert.equal(written.owner.provider, "provider-a");
      assert.equal(written.owner.session_key, "session-1");
      assert.equal(written.owner.pid, process.pid);
      assert.equal(written.owner.host, hostname());

      const read = readHandoffSessionFile(root, "session-1");
      assert.equal(read?.slice.next_action, "run tests");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a second patch preserves fields not present in the new patch", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-1", { blockers: "stuck" });
      await patchHandoffSession(root, "provider-a", "session-1", { next_action: "unstuck it" });
      const read = readHandoffSessionFile(root, "session-1");
      assert.equal(read?.slice.blockers, "stuck");
      assert.equal(read?.slice.next_action, "unstuck it");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readHandoffSessionFile returns null when no file exists", () => {
    const root = tempRoot();
    try {
      assert.equal(readHandoffSessionFile(root, "session-none"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("findDeadPredecessor", () => {
  test("no candidates at all is null", () => {
    const root = tempRoot();
    try {
      assert.equal(findDeadPredecessor(root, "provider-a", "session-new"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dead candidate of the same provider is returned", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-old", { blockers: "left this" });
      const found = findDeadPredecessor(root, "provider-a", "session-new", { probe: DEAD });
      assert.equal(found?.slice.blockers, "left this");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a live candidate is never returned, no matter how it compares on recency", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-old", { blockers: "still running" });
      const found = findDeadPredecessor(root, "provider-a", "session-new", { probe: ALIVE });
      assert.equal(found, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * AD-122 — the gap a discrimination sensor found in the first version of this fix: picking *a* dead
   * predecessor is not enough if two exist, because the wrong one silently wins whenever "first" and "most
   * recent" happen to differ.
   */
  test("AD-122 among two dead candidates, the most recently updated one wins", async () => {
    const root = tempRoot();
    try {
      // why: names invert alphabetical vs chronological order, so a bug that picks the first directory entry
      // instead of the most recent cannot pass by coincidence.
      await patchHandoffSession(root, "provider-a", "session-aaa-stale", {
        blockers: "stale, written first",
      });
      await writeOwnerFields(root, "session-aaa-stale", { updatedAt: "2026-06-01T00:00:00.000Z" });

      await patchHandoffSession(root, "provider-a", "session-zzz-fresh", {
        blockers: "fresh, written second",
      });
      await writeOwnerFields(root, "session-zzz-fresh", { updatedAt: "2026-06-02T00:00:00.000Z" });

      const found = findDeadPredecessor(root, "provider-a", "session-requesting", { probe: DEAD });
      assert.equal(found?.owner.session_key, "session-zzz-fresh");
      assert.equal(found?.slice.blockers, "fresh, written second");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes the querying session's own file", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-1", { blockers: "mine" });
      const found = findDeadPredecessor(root, "provider-a", "session-1", { probe: DEAD });
      assert.equal(found, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes a dead session of a different provider", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-b", "session-1", { blockers: "not yours" });
      const found = findDeadPredecessor(root, "provider-a", "session-new", { probe: DEAD });
      assert.equal(found, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("latestSessionForProvider", () => {
  test("returns the most recently updated session regardless of liveness", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-1", { next_action: "first" });
      await writeOwnerFields(root, "session-1", { updatedAt: "2026-01-01T00:00:00.000Z" });
      await patchHandoffSession(root, "provider-a", "session-2", { next_action: "second" });
      await writeOwnerFields(root, "session-2", { updatedAt: "2026-06-01T00:00:00.000Z" });

      const latest = latestSessionForProvider(root, "provider-a");
      assert.equal(latest?.slice.next_action, "second");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("null when nothing has been written for that provider", () => {
    const root = tempRoot();
    try {
      assert.equal(latestSessionForProvider(root, "provider-a"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pruneDeadHandoffSessions", () => {
  const FAR_FUTURE = Date.parse("2026-01-08T00:00:00.000Z");

  test("deletes a confirmed-dead session past the retention window", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-old", { next_action: "gone" });
      await writeOwnerFields(root, "session-old", { updatedAt: "2026-01-01T00:00:00.000Z" });

      const pruned = pruneDeadHandoffSessions(root, {
        now: FAR_FUTURE,
        staleMs: 24 * 60 * 60 * 1000,
        probe: DEAD,
      });
      assert.equal(pruned, 1);
      assert.equal(readHandoffSessionFile(root, "session-old"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a confirmed-dead session inside the retention window survives", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-recent", { next_action: "still fresh" });
      const pruned = pruneDeadHandoffSessions(root, {
        now: Date.now(),
        staleMs: 24 * 60 * 60 * 1000,
        probe: DEAD,
      });
      assert.equal(pruned, 0);
      assert.notEqual(readHandoffSessionFile(root, "session-recent"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** AD-122 — the one property this function must never violate: age alone is never sufficient to delete. */
  test("a still-alive session survives no matter how old, and is never a candidate for deletion", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-ancient-but-alive", {
        next_action: "still here",
      });
      await writeOwnerFields(root, "session-ancient-but-alive", { updatedAt: "2020-01-01T00:00:00.000Z" });

      const pruned = pruneDeadHandoffSessions(root, {
        now: FAR_FUTURE,
        staleMs: 24 * 60 * 60 * 1000,
        probe: ALIVE,
      });
      assert.equal(pruned, 0);
      assert.notEqual(readHandoffSessionFile(root, "session-ancient-but-alive"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prunes only the dead-and-stale files among a mix, and counts exactly them", async () => {
    const root = tempRoot();
    const ALIVE_PID = 111;
    const DEAD_PID = 222;
    try {
      await patchHandoffSession(root, "provider-a", "dead-stale", { next_action: "x" });
      await writeOwnerFields(root, "dead-stale", { updatedAt: "2026-01-01T00:00:00.000Z", pid: DEAD_PID });

      await patchHandoffSession(root, "provider-a", "dead-fresh", { next_action: "y" });
      await writeOwnerFields(root, "dead-fresh", { updatedAt: "2026-01-07T12:00:00.000Z", pid: DEAD_PID });

      await patchHandoffSession(root, "provider-a", "alive-stale", { next_action: "z" });
      await writeOwnerFields(root, "alive-stale", { updatedAt: "2026-01-01T00:00:00.000Z", pid: ALIVE_PID });

      const pruned = pruneDeadHandoffSessions(root, {
        now: FAR_FUTURE,
        staleMs: 24 * 60 * 60 * 1000,
        probe: (pid) => {
          if (pid === ALIVE_PID) {
            return;
          }
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        },
      });

      assert.equal(
        pruned,
        1,
        "only dead-stale qualifies: dead-fresh is inside the window, alive-stale is alive",
      );
      assert.equal(readHandoffSessionFile(root, "dead-stale"), null);
      assert.notEqual(readHandoffSessionFile(root, "dead-fresh"), null);
      assert.notEqual(readHandoffSessionFile(root, "alive-stale"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns 0 pruned when the sessions directory does not exist yet", () => {
    const root = tempRoot();
    try {
      assert.equal(pruneDeadHandoffSessions(root), 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
