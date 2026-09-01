import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handoffPath, patchHandoffShared, readHandoffFile } from "../handoff.store.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-handoff-"));
}

test("readHandoffFile returns the default v3 shape when no file exists", () => {
  const root = tempRoot();
  try {
    const file = readHandoffFile(root);
    assert.equal(file.schema, "harness.handoff.v3");
    assert.equal(file.shared.mode, "solo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchHandoffShared writes a file matching the v3 schema shape", async () => {
  const root = tempRoot();
  try {
    await patchHandoffShared(root, { git_branch: "main" });
    const file = readHandoffFile(root);
    assert.equal(file.schema, "harness.handoff.v3");
    assert.equal(file.shared.git_branch, "main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHandoffFile falls back to the default on malformed JSON", () => {
  const root = tempRoot();
  try {
    const path = handoffPath(root);
    mkdirSync(join(root, ".tlc", "harness", "state"), { recursive: true });
    writeFileSync(path, "{not json");
    const file = readHandoffFile(root);
    assert.equal(file.schema, "harness.handoff.v3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHandoffFile falls back to the default on a legacy v2 shape", () => {
  const root = tempRoot();
  try {
    const path = handoffPath(root);
    mkdirSync(join(root, ".tlc", "harness", "state"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema: "harness.handoff.v2",
        shared: { mode: "solo", updated_at: "x" },
        by_provider: { a: { updated_at: "x", next_action: "old shape" } },
      }),
    );
    const file = readHandoffFile(root);
    assert.equal(file.schema, "harness.handoff.v3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second patch preserves fields not present in the new patch", async () => {
  const root = tempRoot();
  try {
    await patchHandoffShared(root, { git_branch: "main", project_name: "demo" });
    await patchHandoffShared(root, { git_branch: "feature" });
    const file = readHandoffFile(root);
    assert.equal(file.shared.git_branch, "feature");
    assert.equal(file.shared.project_name, "demo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
