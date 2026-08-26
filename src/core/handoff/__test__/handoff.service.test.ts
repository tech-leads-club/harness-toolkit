import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearStuckSignals, patchHandoff, readForeignSlices, readHandoff } from "../handoff.service.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-handoff-service-"));
}

test("readHandoff merges the provider's own slice over the shared fields", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", {
      shared: { git_branch: "main" },
      slice: { next_action: "run gate" },
    });
    const resolved = readHandoff(root, "provider-a");
    assert.equal(resolved.git_branch, "main");
    assert.equal(resolved.next_action, "run gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHandoff for a provider with no prior slice returns shared fields without throwing", () => {
  const root = tempRoot();
  try {
    const resolved = readHandoff(root, "provider-a");
    assert.equal(resolved.mode, "solo");
    assert.equal(resolved.next_action, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readForeignSlices returns another provider's next_action and blockers labelled by name", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-b", {
      slice: { next_action: "finish migration", blockers: "waiting on ci" },
    });
    const foreign = readForeignSlices(root, "provider-a");
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0]?.provider, "provider-b");
    assert.equal(foreign[0]?.next_action, "finish migration");
    assert.equal(foreign[0]?.blockers, "waiting on ci");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readForeignSlices excludes the requesting provider's own slice", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", { slice: { next_action: "self action" } });
    const foreign = readForeignSlices(root, "provider-a");
    assert.equal(foreign.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readForeignSlices omits a foreign provider that set neither next_action nor blockers", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-b", { slice: { session_narrative: "quiet session" } });
    const foreign = readForeignSlices(root, "provider-a");
    assert.equal(foreign.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearStuckSignals clears blockers/gaps/pending/in_progress/category/next_action for every provider that has one", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", {
      slice: {
        blockers: "Grind cap hit (3 stop loops).",
        last_failure_category: "budget",
        next_action: "Inspect failures, fix root cause, then continue.",
        pending: ["finish the migration"],
        in_progress: ["reviewing PR"],
        previous_gaps: [{ id: "g1", gate: "test", category: "verification", summary: "x" }],
      },
    });
    await patchHandoff(root, "provider-b", { slice: { session_narrative: "quiet session" } });

    const cleared = await clearStuckSignals(root);

    assert.deepEqual(cleared, ["provider-a"]);
    const resolvedA = readHandoff(root, "provider-a");
    assert.equal(resolvedA.blockers, undefined);
    assert.equal(resolvedA.last_failure_category, undefined);
    assert.equal(resolvedA.next_action, undefined);
    assert.equal(resolvedA.pending, undefined);
    assert.equal(resolvedA.in_progress, undefined);
    assert.equal(resolvedA.previous_gaps, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearStuckSignals leaves unrelated fields (session_narrative, last_gate_result) untouched", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", {
      slice: { blockers: "still failing", session_narrative: "kept", last_gate_result: "pass" },
    });
    await clearStuckSignals(root);
    const resolved = readHandoff(root, "provider-a");
    assert.equal(resolved.session_narrative, "kept");
    assert.equal(resolved.last_gate_result, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared fields not touched by a patch survive the patch", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", { shared: { git_branch: "main", project_name: "demo" } });
    await patchHandoff(root, "provider-a", { shared: { git_branch: "feature" } });
    const resolved = readHandoff(root, "provider-a");
    assert.equal(resolved.git_branch, "feature");
    assert.equal(resolved.project_name, "demo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
