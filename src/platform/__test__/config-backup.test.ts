import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { backupBeforeWrite, backupPathFor } from "../config-backup.ts";

const cleanupRoots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "config-backup-"));
  cleanupRoots.push(root);
  return root;
}

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("backupPathFor appends a colon/period-free ISO timestamp and .bak", () => {
  const fixedNow = () => new Date("2026-08-24T12:34:56.789Z");
  const path = backupPathFor("/home/user/.cursor/hooks.json", fixedNow);
  assert.equal(path, "/home/user/.cursor/hooks.json.2026-08-24T12-34-56-789Z.bak");
});

test("backupBeforeWrite writes the given content to the timestamped path, unmodified", () => {
  const root = newRoot();
  const target = join(root, "hooks.json");
  const original = '{"hooks":{"stop":[{"command":"echo hi"}]}}';
  const fixedNow = () => new Date("2026-08-24T00:00:00.000Z");
  backupBeforeWrite(target, original, fixedNow);
  const backupPath = backupPathFor(target, fixedNow);
  assert.ok(existsSync(backupPath));
  assert.equal(readFileSync(backupPath, "utf8"), original);
});