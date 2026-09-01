import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readHandoff } from "../handoff.service.ts";
import { readHandoffSessionFile } from "../handoff.session-store.ts";
import { readHandoffFile } from "../handoff.store.ts";

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const ONCE = join(FIXTURES, "fixtures", "patch-handoff-once.ts");
const AND_WAIT = join(FIXTURES, "fixtures", "patch-handoff-and-wait.ts");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-handoff-concurrency-"));
}

function runPatcher(fixture: string, root: string, provider: string, sessionKey: string, patch: unknown) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, root, provider, sessionKey, JSON.stringify(patch)], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${fixture} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

/** Spawns a session that patches its slice, prints "ready" once the write lands, then blocks until killed. */
function spawnLiveSession(
  root: string,
  provider: string,
  sessionKey: string,
  patch: unknown,
): Promise<{ pid: number; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AND_WAIT, root, provider, sessionKey, JSON.stringify(patch)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready") && child.pid !== undefined) {
        resolve({ pid: child.pid, kill: () => child.kill("SIGKILL") });
      }
    });
  });
}

function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`pid ${pid} did not exit within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

test("two concurrent writers under different sessions of the same provider both survive with no clobbering", async () => {
  const root = tempRoot();
  try {
    await Promise.all([
      runPatcher(ONCE, root, "provider-a", "session-1", { slice: { next_action: "a-action" } }),
      runPatcher(ONCE, root, "provider-a", "session-2", { slice: { next_action: "b-action" } }),
    ]);

    assert.equal(readHandoffSessionFile(root, "session-1")?.slice.next_action, "a-action");
    assert.equal(readHandoffSessionFile(root, "session-2")?.slice.next_action, "b-action");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent writers under the same session merge without losing either field", async () => {
  const root = tempRoot();
  try {
    await Promise.all([
      runPatcher(ONCE, root, "provider-a", "session-1", { slice: { next_action: "run tests" } }),
      runPatcher(ONCE, root, "provider-a", "session-1", { slice: { blockers: "flaky ci" } }),
    ]);

    const slice = readHandoffSessionFile(root, "session-1")?.slice;
    assert.equal(slice?.next_action, "run tests");
    assert.equal(slice?.blockers, "flaky ci");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent writers touching shared while writing distinct sessions leave both files valid", async () => {
  const root = tempRoot();
  try {
    await Promise.all([
      runPatcher(ONCE, root, "provider-a", "session-1", {
        shared: { git_branch: "main" },
        slice: { next_action: "a-action" },
      }),
      runPatcher(ONCE, root, "provider-b", "session-2", {
        shared: { project_name: "demo" },
        slice: { next_action: "b-action" },
      }),
    ]);

    assert.equal(readHandoffFile(root).schema, "harness.handoff.v3");
    assert.equal(readHandoffSessionFile(root, "session-1")?.slice.next_action, "a-action");
    assert.equal(readHandoffSessionFile(root, "session-2")?.slice.next_action, "b-action");
    assert.equal(readHandoffFile(root).shared.git_branch, "main");
    assert.equal(readHandoffFile(root).shared.project_name, "demo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * AD-122 — the property the whole fix exists for: a session's own read must never surface a live neighbour's
 * blockers, and must inherit a genuinely-dead predecessor's. Both halves verified against a real process, not a
 * mocked probe, because a mocked probe cannot prove the extraction actually asks the OS.
 */
test("AD-122 a new session does not inherit a still-live neighbour's continuity", async () => {
  const root = tempRoot();
  const live = await spawnLiveSession(root, "provider-a", "session-old", {
    blockers: "old session is stuck",
    next_action: "do not surface this to session-new",
  });
  try {
    const resolved = readHandoff(root, "provider-a", "session-new");
    assert.equal(resolved.blockers, undefined, "a live neighbour's blockers must not leak");
    assert.equal(resolved.next_action, undefined);
  } finally {
    live.kill();
    await waitForExit(live.pid);
    rmSync(root, { recursive: true, force: true });
  }
});

test("AD-122 a new session inherits the same neighbour's continuity once it is confirmed dead", async () => {
  const root = tempRoot();
  const live = await spawnLiveSession(root, "provider-a", "session-old", {
    blockers: "old session is stuck",
    next_action: "surface this once session-old is gone",
  });
  try {
    live.kill();
    await waitForExit(live.pid);

    const resolved = readHandoff(root, "provider-a", "session-new");
    assert.equal(resolved.blockers, "old session is stuck");
    assert.equal(resolved.next_action, "surface this once session-old is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
