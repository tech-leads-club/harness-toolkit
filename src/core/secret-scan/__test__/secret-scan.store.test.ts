import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { projectStateDir } from "../../../platform/paths.ts";
import { placeholderFor } from "../secret-scan.store.ts";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-secret-scan-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("EFH-08: calling twice with the same matchedText in the same session returns the same placeholder", () => {
  const root = newRoot();
  const first = placeholderFor(root, "session-a", "AKIAABCDEFGHIJKLMNOP", "aws-access-key");
  const second = placeholderFor(root, "session-a", "AKIAABCDEFGHIJKLMNOP", "aws-access-key");
  assert.equal(first, second);
});

test("different matchedText values in the same session get distinct placeholders", () => {
  const root = newRoot();
  const first = placeholderFor(root, "session-a", "AKIAABCDEFGHIJKLMNOP", "aws-access-key");
  const second = placeholderFor(root, "session-a", "ghp_1234567890abcdefghijklmnopqrstuvwxyz", "github-token");
  assert.notEqual(first, second);
});

test("a corrupt/unparseable store file is treated as empty rather than throwing", () => {
  const root = newRoot();
  mkdirSync(projectStateDir(root), { recursive: true });
  writeFileSync(join(projectStateDir(root), "secret-redaction.json"), "{ not valid json", "utf8");
  assert.doesNotThrow(() => placeholderFor(root, "session-a", "some-secret-value", "entropy"));
  const placeholder = placeholderFor(root, "session-a", "some-secret-value", "entropy");
  assert.match(placeholder, /^\[REDACTED:entropy:[0-9a-f]{8}\]$/);
});

test("the raw matchedText never appears in the written store file", () => {
  const root = newRoot();
  const secret = "AKIAABCDEFGHIJKLMNOP";
  placeholderFor(root, "session-a", secret, "aws-access-key");
  const written = readFileSync(join(projectStateDir(root), "secret-redaction.json"), "utf8");
  assert.doesNotMatch(written, new RegExp(secret));
});
