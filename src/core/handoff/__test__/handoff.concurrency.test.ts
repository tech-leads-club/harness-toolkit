import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readHandoffSessionFile } from "../handoff.session-store.ts";
import { readHandoffFile } from "../handoff.store.ts";

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const ONCE = join(FIXTURES, "fixtures", "patch-handoff-once.ts");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-handoff-concurrency-"));
}

function runPatcher(root: string, provider: string, sessionKey: string, patch: unknown) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [ONCE, root, provider, sessionKey, JSON.stringify(patch)], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${ONCE} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

test("two concurrent writers under different sessions of the same provider both survive with no clobbering", async () => {
  const root = tempRoot();
  try {
    await Promise.all([
      runPatcher(root, "provider-a", "session-1", { slice: { next_action: "a-action" } }),
      runPatcher(root, "provider-a", "session-2", { slice: { next_action: "b-action" } }),
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
      runPatcher(root, "provider-a", "session-1", { slice: { next_action: "run tests" } }),
      runPatcher(root, "provider-a", "session-1", { slice: { blockers: "flaky ci" } }),
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
      runPatcher(root, "provider-a", "session-1", {
        shared: { git_branch: "main" },
        slice: { next_action: "a-action" },
      }),
      runPatcher(root, "provider-b", "session-2", {
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
