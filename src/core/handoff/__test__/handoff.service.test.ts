import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearStuckSignals,
  patchHandoff,
  readForeignSlices,
  readHandoff,
  readLatestSlice,
} from "../handoff.service.ts";
import { patchHandoffSession } from "../handoff.session-store.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-handoff-service-"));
}

/**
 * why no fabrication for "not live": `isSessionLive`'s own reading is "not live" whenever no presence record
 * exists at all, which is the ordinary state for a session that simply ended — nothing needs simulating for
 * that case. Only "live" needs a real presence record, since that is the state a quiet session does not have
 * ([/decisions/ad-122.md](/decisions/ad-122.md)).
 */
async function markLive(root: string, provider: string, sessionKey: string): Promise<void> {
  const { register } = await import("../../presence/presence.service.ts");
  const session = sessionKey.startsWith(`${provider}-`) ? sessionKey.slice(provider.length + 1) : sessionKey;
  register(root, { provider, session, pid: process.pid, branch: "main" });
}

test("readHandoff merges the provider's own slice over the shared fields", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", "session-1", {
      shared: { git_branch: "main" },
      slice: { next_action: "run gate" },
    });
    const resolved = readHandoff(root, "provider-a", "session-1");
    assert.equal(resolved.git_branch, "main");
    assert.equal(resolved.next_action, "run gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHandoff for a session with no prior slice returns shared fields without throwing", () => {
  const root = tempRoot();
  try {
    const resolved = readHandoff(root, "provider-a", "session-1");
    assert.equal(resolved.mode, "solo");
    assert.equal(resolved.next_action, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * why a real presence record and not an injected stub: this is the exact case a discrimination sensor found
 * unreachable in the first version of this fix — a "live" fixture modeled as a process that never exits, which
 * this harness's one-shot hook processes can never be. A real, freshly-heartbeated presence record is the one
 * fixture that cannot pass by accident ([/decisions/ad-122.md](/decisions/ad-122.md)).
 */
test("AD-122 readHandoff never surfaces a genuinely live session's fields, even under the same provider", async () => {
  const root = tempRoot();
  try {
    await patchHandoffSession(root, "provider-a", "session-live", {
      blockers: "session-live is stuck",
      next_action: "do not surface",
    });
    await markLive(root, "provider-a", "session-live");

    const resolved = readHandoff(root, "provider-a", "session-new");
    assert.equal(resolved.blockers, undefined);
    assert.equal(resolved.next_action, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AD-122 readHandoff inherits a not-live predecessor's fields under the same provider", async () => {
  const root = tempRoot();
  try {
    await patchHandoffSession(root, "provider-a", "session-dead", {
      blockers: "session-dead left this",
      next_action: "pick this up",
    });
    const resolved = readHandoff(root, "provider-a", "session-new");
    assert.equal(resolved.blockers, "session-dead left this");
    assert.equal(resolved.next_action, "pick this up");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AD-122 a not-live predecessor of a different provider is never inherited", async () => {
  const root = tempRoot();
  try {
    await patchHandoffSession(root, "provider-b", "session-dead", { blockers: "provider-b's own problem" });
    const resolved = readHandoff(root, "provider-a", "session-new");
    assert.equal(resolved.blockers, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AD-122 the session's own field always wins over an inherited predecessor's", async () => {
  const root = tempRoot();
  try {
    await patchHandoffSession(root, "provider-a", "session-dead", { next_action: "stale" });
    await patchHandoffSession(root, "provider-a", "session-new", { next_action: "fresh" });
    const resolved = readHandoff(root, "provider-a", "session-new");
    assert.equal(resolved.next_action, "fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** AD-122/F2 — a predecessor whose own file diverged outside a harness write is never inherited. */
test("AD-122 readHandoff withholds a tampered predecessor's slice", async () => {
  const root = tempRoot();
  try {
    await patchHandoffSession(root, "provider-a", "session-dead", {
      blockers: "session-dead left this",
    });
    const { handoffSessionPath } = await import("../handoff.session-store.ts");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const path = handoffSessionPath(root, "session-dead");
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.slice.blockers = "INJECTED BY A NON-HARNESS WRITER";
    writeFileSync(path, JSON.stringify(file));

    const resolved = readHandoff(root, "provider-a", "session-new");
    assert.equal(resolved.blockers, undefined, "a diverged predecessor is withheld, not inherited");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readLatestSlice returns whichever session most recently wrote, live or not", async () => {
  const root = tempRoot();
  try {
    await patchHandoffSession(root, "provider-a", "session-1", { next_action: "first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await patchHandoffSession(root, "provider-a", "session-2", { next_action: "second" });
    const resolved = readLatestSlice(root, "provider-a");
    assert.equal(resolved.next_action, "second");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readForeignSlices returns another provider's next_action and blockers labelled by name", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-b", "session-1", {
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

test("readForeignSlices excludes the requesting provider's own sessions", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", "session-1", { slice: { next_action: "self action" } });
    const foreign = readForeignSlices(root, "provider-a");
    assert.equal(foreign.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readForeignSlices omits a foreign provider that set neither next_action nor blockers", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-b", "session-1", { slice: { session_narrative: "quiet session" } });
    const foreign = readForeignSlices(root, "provider-a");
    assert.equal(foreign.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** AD-122/F2 — a foreign slice whose own file diverged outside a harness write is never surfaced. */
test("AD-122 readForeignSlices withholds a tampered foreign session's slice", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-b", "session-1", {
      slice: { next_action: "finish migration", blockers: "waiting on ci" },
    });
    const { handoffSessionPath } = await import("../handoff.session-store.ts");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const path = handoffSessionPath(root, "session-1");
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.slice.next_action = "INJECTED BY A NON-HARNESS WRITER";
    writeFileSync(path, JSON.stringify(file));

    const foreign = readForeignSlices(root, "provider-a");
    assert.equal(foreign.length, 0, "a diverged foreign file is withheld, not surfaced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearStuckSignals clears blockers/gaps/category/next_action for every session that has one", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", "session-1", {
      slice: {
        blockers: "Grind cap hit (3 stop loops).",
        last_failure_category: "budget",
        next_action: "Inspect failures, fix root cause, then continue.",
        previous_gaps: [{ id: "g1", gate: "test", category: "verification", summary: "x" }],
      },
    });
    await patchHandoff(root, "provider-b", "session-2", { slice: { session_narrative: "quiet session" } });

    const cleared = await clearStuckSignals(root);

    assert.deepEqual(cleared, ["provider-a:session-1"]);
    const resolvedA = readHandoff(root, "provider-a", "session-1");
    assert.equal(resolvedA.blockers, undefined);
    assert.equal(resolvedA.last_failure_category, undefined);
    assert.equal(resolvedA.next_action, undefined);
    assert.equal(resolvedA.previous_gaps, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearStuckSignals leaves unrelated fields (session_narrative, last_gate_result) untouched", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", "session-1", {
      slice: { blockers: "still failing", session_narrative: "kept", last_gate_result: "pass" },
    });
    await clearStuckSignals(root);
    const resolved = readHandoff(root, "provider-a", "session-1");
    assert.equal(resolved.session_narrative, "kept");
    assert.equal(resolved.last_gate_result, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared fields not touched by a patch survive the patch", async () => {
  const root = tempRoot();
  try {
    await patchHandoff(root, "provider-a", "session-1", {
      shared: { git_branch: "main", project_name: "demo" },
    });
    await patchHandoff(root, "provider-a", "session-1", { shared: { git_branch: "feature" } });
    const resolved = readHandoff(root, "provider-a", "session-1");
    assert.equal(resolved.git_branch, "feature");
    assert.equal(resolved.project_name, "demo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
