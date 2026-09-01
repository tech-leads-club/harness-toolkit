import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  findDeadPredecessor,
  handoffSessionPath,
  latestSessionForProvider,
  patchHandoffSession,
  pruneDeadHandoffSessions,
  readHandoffSessionFile,
} from "../handoff.session-store.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-handoff-session-store-"));
}

const NOT_LIVE = () => false;
const LIVE = () => true;

/** Rewrites a session file's owner `updated_at` in place, bypassing `patchHandoffSession`'s own
 * restamp-on-write — the only way to construct a fixture with a specific, chosen timestamp after the fact. */
async function writeUpdatedAt(root: string, sessionKey: string, updatedAt: string): Promise<void> {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const path = handoffSessionPath(root, sessionKey);
  const file = JSON.parse(readFileSync(path, "utf8"));
  file.owner.updated_at = updatedAt;
  file.slice.updated_at = updatedAt;
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

  test("a not-live candidate of the same provider is returned", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-old", { blockers: "left this" });
      const found = findDeadPredecessor(root, "provider-a", "session-new", { isLive: NOT_LIVE });
      assert.equal(found?.slice.blockers, "left this");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a live candidate is never returned, no matter how it compares on recency", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-old", { blockers: "still running" });
      const found = findDeadPredecessor(root, "provider-a", "session-new", { isLive: LIVE });
      assert.equal(found, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** why: a discrimination sensor found that picking *a* not-live predecessor is not enough if two exist,
   * because the wrong one silently wins whenever "first" and "most recent" happen to differ. */
  test("AD-122 among two not-live candidates, the most recently updated one wins", async () => {
    const root = tempRoot();
    try {
      // why: names invert alphabetical vs chronological order, so a bug that picks the first directory entry
      // instead of the most recent cannot pass by coincidence.
      await patchHandoffSession(root, "provider-a", "session-aaa-stale", {
        blockers: "stale, written first",
      });
      await writeUpdatedAt(root, "session-aaa-stale", "2026-06-01T00:00:00.000Z");

      await patchHandoffSession(root, "provider-a", "session-zzz-fresh", {
        blockers: "fresh, written second",
      });
      await writeUpdatedAt(root, "session-zzz-fresh", "2026-06-02T00:00:00.000Z");

      const found = findDeadPredecessor(root, "provider-a", "session-requesting", { isLive: NOT_LIVE });
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
      const found = findDeadPredecessor(root, "provider-a", "session-1", { isLive: NOT_LIVE });
      assert.equal(found, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes a not-live session of a different provider", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-b", "session-1", { blockers: "not yours" });
      const found = findDeadPredecessor(root, "provider-a", "session-new", { isLive: NOT_LIVE });
      assert.equal(found, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** why this test exists at all: every other case above injects `isLive` — this is the one that proves the
   * *default* wiring (real presence, no override) also tells a genuinely-live session apart from a quiet one,
   * which is the exact property AD-122 exists to guarantee end to end. */
  test("AD-122 the real, non-injected default correctly reads a live presence record", async () => {
    const root = tempRoot();
    const { register } = await import("../../presence/presence.service.ts");
    try {
      register(root, { provider: "provider-a", session: "old", pid: 4242, branch: "main" });
      await patchHandoffSession(root, "provider-a", "provider-a-old", { blockers: "still in conversation" });

      const found = findDeadPredecessor(root, "provider-a", "provider-a-new");
      assert.equal(found, null, "a real, freshly-heartbeated presence record must not read as dead");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AD-122 the real, non-injected default inherits once no presence record exists", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "provider-a-old", { blockers: "conversation ended" });
      const found = findDeadPredecessor(root, "provider-a", "provider-a-new");
      assert.equal(found?.slice.blockers, "conversation ended");
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
      await writeUpdatedAt(root, "session-1", "2026-01-01T00:00:00.000Z");
      await patchHandoffSession(root, "provider-a", "session-2", { next_action: "second" });
      await writeUpdatedAt(root, "session-2", "2026-06-01T00:00:00.000Z");

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

  test("deletes a not-live session past the retention window", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-old", { next_action: "gone" });
      await writeUpdatedAt(root, "session-old", "2026-01-01T00:00:00.000Z");

      const pruned = pruneDeadHandoffSessions(root, {
        now: FAR_FUTURE,
        staleMs: 24 * 60 * 60 * 1000,
        isLive: NOT_LIVE,
      });
      assert.equal(pruned, 1);
      assert.equal(readHandoffSessionFile(root, "session-old"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a not-live session inside the retention window survives", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-recent", { next_action: "still fresh" });
      const pruned = pruneDeadHandoffSessions(root, {
        now: Date.now(),
        staleMs: 24 * 60 * 60 * 1000,
        isLive: NOT_LIVE,
      });
      assert.equal(pruned, 0);
      assert.notEqual(readHandoffSessionFile(root, "session-recent"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** AD-122 — the one property this function must never violate: age alone is never sufficient to delete. */
  test("a live session survives no matter how old, and is never a candidate for deletion", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-ancient-but-alive", {
        next_action: "still here",
      });
      await writeUpdatedAt(root, "session-ancient-but-alive", "2020-01-01T00:00:00.000Z");

      const pruned = pruneDeadHandoffSessions(root, {
        now: FAR_FUTURE,
        staleMs: 24 * 60 * 60 * 1000,
        isLive: LIVE,
      });
      assert.equal(pruned, 0);
      assert.notEqual(readHandoffSessionFile(root, "session-ancient-but-alive"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prunes only the not-live-and-stale files among a mix, and counts exactly them", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "dead-stale", { next_action: "x" });
      await writeUpdatedAt(root, "dead-stale", "2026-01-01T00:00:00.000Z");

      await patchHandoffSession(root, "provider-a", "dead-fresh", { next_action: "y" });
      await writeUpdatedAt(root, "dead-fresh", "2026-01-07T12:00:00.000Z");

      await patchHandoffSession(root, "provider-a", "alive-stale", { next_action: "z" });
      await writeUpdatedAt(root, "alive-stale", "2026-01-01T00:00:00.000Z");

      const pruned = pruneDeadHandoffSessions(root, {
        now: FAR_FUTURE,
        staleMs: 24 * 60 * 60 * 1000,
        isLive: (_provider, sessionKey) => sessionKey === "alive-stale",
      });

      assert.equal(
        pruned,
        1,
        "only dead-stale qualifies: dead-fresh is inside the window, alive-stale is live",
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

  /** AD-122/F3 — an orphaned seal sidecar is otherwise never cleaned up. */
  test("prunes the seal sidecar alongside a deleted session file", async () => {
    const root = tempRoot();
    try {
      await patchHandoffSession(root, "provider-a", "session-old", { next_action: "gone" });
      await writeUpdatedAt(root, "session-old", "2026-01-01T00:00:00.000Z");

      const { sealPath } = await import("../../integrity/state-seal.ts");
      const { existsSync } = await import("node:fs");
      const path = handoffSessionPath(root, "session-old");
      assert.equal(existsSync(sealPath(path)), true, "the write path already seals on every patch");

      pruneDeadHandoffSessions(root, { now: FAR_FUTURE, staleMs: 24 * 60 * 60 * 1000, isLive: NOT_LIVE });
      assert.equal(existsSync(sealPath(path)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
