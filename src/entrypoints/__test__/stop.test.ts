import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { coreFacade } from "../../core/index.ts";

import { projectConfigPath } from "../../platform/paths.ts";
import { claudeWiring } from "../../providers/index.ts";

import { responseAfterHandler } from "../response-after.ts";
import { type RunOutcome, runHandler } from "../run.ts";
import { STOP_LOCK_WAIT_MS, stopHandler, stopLockWaitMs } from "../stop.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function repoWithChange(): string {
  const dir = mkdtempSync(join(tmpdir(), "tlc-stop-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, ".gitignore"), ".tlc/\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 2;\n");
  return dir;
}

function cleanRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tlc-stop-clean-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, ".gitignore"), ".tlc/\n");
  writeFileSync(join(dir, "readme.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function writeProjectPolicy(root: string, patch: Record<string, unknown>): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(patch, null, 2), "utf8");
}

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

function cursorStop(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "stop",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    status: "completed",
    ...overrides,
  });
}

function claudeStop(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    cwd: root,
    session_id: "sess-1",
    status: "completed",
    ...overrides,
  });
}

const ALWAYS_FAIL = { grind: { enabled: true, lintCommand: ["node", "-e", "process.exit(1)"] } };
const ALWAYS_PASS = { grind: { enabled: true, lintCommand: ["node", "-e", "process.exit(0)"] } };

test("a lint gate failure yields continue (followup_message) under Cursor", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    assert.match(String(outcome.rendered.stdout), /"followup_message"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same lint gate failure yields {"decision":"block"} under Claude', async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    const outcome = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    assert.match(String(outcome.rendered.stdout), /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("six consecutive Claude stops with maxLoops 5 block on attempts 1-5", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { grind: { ...ALWAYS_FAIL.grind, maxLoops: 5 } });
    for (let i = 0; i < 5; i++) {
      const outcome = await runHandler(stopHandler, stdinOf(claudeStop(root)));
      assert.equal(outcome.decision.kind, "continue", `attempt ${i + 1} should block`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sixth consecutive Claude stop abstains once the loop cap is reached", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { grind: { ...ALWAYS_FAIL.grind, maxLoops: 5 } });
    let last: RunOutcome | undefined;
    for (let i = 0; i < 6; i++) {
      last = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    }
    assert.equal(last?.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hitting the loop cap records a budget blocker in the handoff", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { grind: { ...ALWAYS_FAIL.grind, maxLoops: 5 } });
    for (let i = 0; i < 6; i++) {
      await runHandler(stopHandler, stdinOf(claudeStop(root)));
    }
    const handoff = coreFacade.handoff.readHandoff(root, "claude");
    assert.equal(handoff.last_failure_category, "budget");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor uses the payload's native loop_count for the cap check", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { grind: { ...ALWAYS_FAIL.grind, maxLoops: 5 } });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root, { loop_count: 10 })));
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh Claude session's first stop is not capped even without a native loop_count", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { grind: { ...ALWAYS_FAIL.grind, maxLoops: 5 } });
    const outcome = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(outcome.decision.kind, "continue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fingerprint repeated twice emits the stagnation follow-up", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    await runHandler(stopHandler, stdinOf(cursorStop(root)));
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /identical validation fingerprint repeated/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fingerprint repeated twice records a candidate lesson for the gate", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { ...ALWAYS_FAIL, intelligence: { lessons: { enabled: true } } });
    await runHandler(stopHandler, stdinOf(cursorStop(root)));
    await runHandler(stopHandler, stdinOf(cursorStop(root)));
    const lessons = coreFacade.lesson.readProjectLessons(root);
    assert.ok(lessons.some((l) => l.failedGate === "lint" && l.source === "project"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single lint failure (not yet stagnant) yields the normal BLOCKED text, not the stagnation follow-up", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.ok(!outcome.decision.text.includes("identical validation fingerprint repeated"));
      assert.match(outcome.decision.text, /BLOCKED: lint failed/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ship claim with an empty diff yields continue when emptyDiffAntiShip is on", async () => {
  const root = cleanRepo();
  try {
    writeProjectPolicy(root, { shipGate: { enabled: true, emptyDiffAntiShip: true } });
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: {
        last_ship_claim_kind: "structured",
        last_ship_claim_at: new Date().toISOString(),
        last_ship_claim_snippet: "HARNESS_SHIP_CLAIM: done",
      },
    });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /empty diff/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ship claim with a non-empty diff does not trigger the empty-diff gate", async () => {
  const root = repoWithChange();
  try {
    const evidenceDir = join(root, "evidence", "run-1");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "90-verdict.txt"), "PASS\n");
    writeProjectPolicy(root, {
      shipGate: { enabled: true, emptyDiffAntiShip: true, evidenceDir: join(root, "evidence") },
    });
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: {
        last_ship_claim_kind: "structured",
        last_ship_claim_at: new Date().toISOString(),
      },
    });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: this test used to assert the defect. A live neighbour made the stop return `continue` — which renders as
 * `{"decision":"block"}` — so a session was blocked because a sibling was mid-gate, told to "wait for it to
 * release", which a stop hook cannot do. Reported from the field three times in one day
 * ([/decisions/ad-073.md](/decisions/ad-073.md)).
 */
test("a grind lock held by a neighbour defers the gate instead of blocking the turn", async () => {
  const root = repoWithChange();
  const previous = process.env.TLC_TEST_GATE_LOCK_WAIT_MS;
  process.env.TLC_TEST_GATE_LOCK_WAIT_MS = "150";
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    let release: () => void = () => {};
    const held = coreFacade.gate.withGateLock(
      root,
      "claude",
      "other-session",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const startedAt = Date.now();
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    const elapsedMs = Date.now() - startedAt;
    // invariant: the turn ends. Nothing tells the model to wait, because it has no way to.
    assert.equal(outcome.decision.kind, "abstain");
    /**
     * hazard: asserting the bound as a constant was not enough — a mutant that stopped *passing* it fell back to
     * the library's 120-second default, still deferred, and passed every other assertion while taking two
     * minutes. Only elapsed time proves the seam reaches the lock. The bound is generous against the 120s it
     * catches, so it is not a timing race.
     */
    assert.equal(
      elapsedMs < 30_000,
      true,
      `the wait honoured the seam: ${elapsedMs}ms, not the ${coreFacade.gate.GATE_LOCK_WAIT_MS}ms default`,
    );

    // invariant: `skipped`, never `pass` — no gate produced a verdict for this turn.
    const handoff = coreFacade.handoff.readHandoff(root, "cursor");
    assert.equal(handoff?.last_gate_result, "skipped");
    assert.match(handoff?.next_action ?? "", /other-session/);

    // invariant: the plane comes from the resolver, not from a guess. Reading `debug.jsonl` found nothing because
    // `gate.outcome` resolves to signal — the plane mismatch AD-065 built a checker for, made here in a test.
    const plane =
      coreFacade.observability.resolveObsLevel("gate.outcome") === "signal" ? "obs.jsonl" : "debug.jsonl";
    const deferrals = coreFacade.observability
      .readSignalEvents(root, plane, 200)
      .filter((event) => event.kind === "gate.outcome" && event.attrs?.deferred_to !== undefined);
    assert.equal(deferrals.length > 0, true, "the deferral is recorded, not only narrated");
    assert.match(String(deferrals[0]?.attrs?.deferred_to ?? ""), /other-session/);
    release();
    await held;
  } finally {
    if (previous === undefined) {
      delete process.env.TLC_TEST_GATE_LOCK_WAIT_MS;
    } else {
      process.env.TLC_TEST_GATE_LOCK_WAIT_MS = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: the sharpest half of the defect. `runLockedGate` consults the recorded verdict *before* taking the lock,
 * so a turn whose inputs hash to what a neighbour already verified needs no lock at all — and the pre-check
 * returned `continue` before that line was ever reached. A usable verdict sat on disk, unread, while the turn was
 * blocked ([/decisions/ad-073.md](/decisions/ad-073.md)).
 */
test("a reusable verdict is honoured while a neighbour holds the lock", async () => {
  const root = repoWithChange();
  const previous = process.env.TLC_TEST_GATE_LOCK_WAIT_MS;
  process.env.TLC_TEST_GATE_LOCK_WAIT_MS = "150";
  try {
    writeProjectPolicy(root, ALWAYS_PASS);
    // the neighbour's run: it takes the lock, passes, and leaves a verdict keyed on these inputs
    const first = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(first.decision.kind, "abstain");

    let release: () => void = () => {};
    const held = coreFacade.gate.withGateLock(
      root,
      "claude",
      "other-session",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "abstain");

    // invariant: reused, not deferred. The lock was never needed, so a live holder is irrelevant.
    const handoff = coreFacade.handoff.readHandoff(root, "cursor");
    assert.equal(handoff?.last_gate_result, "pass");

    const plane =
      coreFacade.observability.resolveObsLevel("gate.outcome") === "signal" ? "obs.jsonl" : "debug.jsonl";
    const outcomes = coreFacade.observability
      .readSignalEvents(root, plane, 200)
      .filter((event) => event.kind === "gate.outcome");
    assert.equal(
      outcomes.some((event) => event.attrs?.reused === true),
      true,
      "the second turn reused the neighbour's verdict",
    );
    assert.equal(
      outcomes.some((event) => event.attrs?.deferred_to !== undefined),
      false,
      "nothing deferred, because nothing waited",
    );
    release();
    await held;
  } finally {
    if (previous === undefined) {
      delete process.env.TLC_TEST_GATE_LOCK_WAIT_MS;
    } else {
      process.env.TLC_TEST_GATE_LOCK_WAIT_MS = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// hazard: the process holding the lock can die without releasing it. Before this case the stop reported
// the dead holder and returned, so withGateLock never ran and the grind stayed blocked indefinitely —
// the stale threshold was unreachable from the only path that reaches it in production.
test("a stale grind lock left by a dead process does not block the stop", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    const lockPath = join(root, ".tlc", "harness", "state", "grind.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        provider: "claude",
        session: "dead-session",
        pid: 999_999,
        acquired_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      }),
    );
    const past = new Date(Date.now() - 40 * 60 * 1000);
    utimesSync(lockPath, past, past);

    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.doesNotMatch(outcome.decision.text, /grind lock is held by/);
      assert.match(outcome.decision.text, /lint/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a grind lock held by another provider does not block a stop when grind is disabled", async () => {
  const root = cleanRepo();
  try {
    let release: () => void = () => {};
    const held = coreFacade.gate.withGateLock(
      root,
      "claude",
      "other-session",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
    release();
    await held;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gate pass clears the stagnation fingerprint", async () => {
  const root = cleanRepo();
  try {
    coreFacade.stagnation.trackFingerprint(root, "cursor-conv-1", "abc123");
    assert.equal(coreFacade.stagnation.fingerprintHits(root, "cursor-conv-1"), 1);
    await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(coreFacade.stagnation.fingerprintHits(root, "cursor-conv-1"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gate pass clears the shell stall state", async () => {
  const root = cleanRepo();
  try {
    writeProjectPolicy(root, { shell: { stallDetection: true } });
    coreFacade.shellPolicy.evaluateShellCommand({
      mode: "solo" as const,
      command: "npm test",
      sessionKey: "cursor-conv-1",
      projectDir: root,
      catastrophicAsk: true,
      stallDetection: true,
      stallRepeatThreshold: 3,
    });
    await runHandler(stopHandler, stdinOf(cursorStop(root)));
    const { shellStallHits } = await import("../../core/shell-policy/shell-policy.stall.ts");
    assert.equal(shellStallHits(root, "cursor-conv-1"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gate pass resets the loop counter", async () => {
  const root = cleanRepo();
  try {
    coreFacade.turn.nextLoop(root, "claude-sess-1");
    coreFacade.turn.nextLoop(root, "claude-sess-1");
    assert.equal(coreFacade.turn.currentLoopCount(root, "claude-sess-1"), 2);
    await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(coreFacade.turn.currentLoopCount(root, "claude-sess-1"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-completed status abstains without running any gate", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root, { status: "aborted" })));
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a skip-verify flag abstains without running any gate", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    const { flagsDir } = await import("../../platform/paths.ts");
    mkdirSync(flagsDir(root), { recursive: true });
    writeFileSync(join(flagsDir(root), "skip-verify"), "1");
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undeclared comment added this turn blocks the stop", async () => {
  const root = repoWithChange();
  try {
    writeFileSync(join(root, "src", "app.ts"), "// get the value\nexport const a = 2;\n");
    writeProjectPolicy(root, { comments: { enabled: true, onViolation: "followup" } });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /added 1 comment/);
      assert.match(outcome.decision.text, /why:/);
      assert.match(outcome.decision.text, /get the value/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a comment declaring why passes the stop", async () => {
  const root = repoWithChange();
  try {
    writeFileSync(
      join(root, "src", "app.ts"),
      "// why: upstream returns 0 for a missing key, not null\nexport const a = 2;\n",
    );
    writeProjectPolicy(root, { comments: { enabled: true, onViolation: "followup" } });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.notEqual(outcome.decision.kind, "continue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: every other comment-rail test here changes an `.ts` file, which passes both `codeTargets`'s nine-extension
// regex and the syntax catalog — so none of them can tell the rail's own scope apart from grind's. This one uses
// a language only the catalog knows, which is what actually pins the fix: reverting the rail to `codeTargets`
// makes this pass silently while every other test in this file stays green.
test("an undeclared comment in a language codeTargets does not recognise still blocks the stop", async () => {
  const root = repoWithChange();
  try {
    writeFileSync(join(root, "src", "main.tf"), '# get the region\nresource "aws_s3_bucket" "b" {}\n');
    writeProjectPolicy(root, { comments: { enabled: true, onViolation: "followup" } });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /get the region/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("budgetContinue with unfinished work under pressure yields continue", async () => {
  const root = cleanRepo();
  try {
    writeProjectPolicy(root, { intelligence: { budgetContinue: true, budgetContinueAfterLoops: 1 } });
    await coreFacade.handoff.patchHandoff(root, "claude", { slice: { blockers: "still working" } });
    coreFacade.turn.nextLoop(root, "claude-sess-1");
    const outcome = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /do not summarize/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a test gate failure also yields a continue/block decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "tlc-stop-test-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    writeFileSync(join(root, ".gitignore"), ".tlc/\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.test.ts"), "export const a = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "initial"]);
    writeFileSync(join(root, "src", "app.test.ts"), "export const a = 2;\n");
    writeProjectPolicy(root, { grind: { enabled: true, testCommand: ["node", "-e", "process.exit(1)"] } });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean tree with no grind enabled passes and abstains under Cursor", async () => {
  const root = cleanRepo();
  try {
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean tree with no grind enabled passes and abstains under Claude", async () => {
  const root = cleanRepo();
  try {
    const outcome = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ship-evidence gate without recent evidence blocks a recent structured claim", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { shipGate: { enabled: true, evidenceDir: join(root, "evidence") } });
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: {
        last_ship_claim_kind: "structured",
        last_ship_claim_at: new Date().toISOString(),
      },
    });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /production PASS evidence/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ship-evidence gate with recent PASS evidence appends a pass ledger row and proceeds", async () => {
  const root = repoWithChange();
  try {
    const evidenceDir = join(root, "evidence", "run-1");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "90-verdict.txt"), "PASS\n");
    writeProjectPolicy(root, { shipGate: { enabled: true, evidenceDir: join(root, "evidence") } });
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: {
        last_ship_claim_kind: "structured",
        last_ship_claim_at: new Date().toISOString(),
      },
    });
    await runHandler(stopHandler, stdinOf(cursorStop(root)));
    const ledger = coreFacade.ship.readShipLedger(root);
    assert.ok(ledger.some((row) => row.event === "pass" && row.provider === "cursor"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the handoff records last_stop_status and last_changed_files even on the early-skip path", async () => {
  const root = repoWithChange();
  try {
    await runHandler(stopHandler, stdinOf(cursorStop(root, { status: "aborted" })));
    const handoff = coreFacade.handoff.readHandoff(root, "cursor");
    assert.equal(handoff.last_stop_status, "aborted");
    assert.ok(handoff.last_changed_files?.includes("src/app.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lint failure records last_gate_result fail in the handoff", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    await runHandler(stopHandler, stdinOf(cursorStop(root)));
    const handoff = coreFacade.handoff.readHandoff(root, "cursor");
    assert.equal(handoff.last_gate_result, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// DC-01 / DC-02: the gate is the project's own command, run through the shared gate path.
const FAILING_DOCS = ["node", "-e", "console.error('doc x is stale'); process.exit(1)"];
const PASSING_DOCS = ["node", "-e", "process.exit(0)"];

test("a passing docs command lets the stop through", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { docs: { command: PASSING_DOCS } });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.notEqual(outcome.decision.kind, "continue");
    assert.notEqual(outcome.decision.kind, "context");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing docs command at warn injects the tool output and does not block", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { docs: { command: FAILING_DOCS, severity: "warn" } });
    const outcome = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.match(outcome.decision.text, /^ADVISORY/);
      assert.match(outcome.decision.text, /doc x is stale/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: this test asserted the advisory on a Cursor stop event, and Cursor's `stop` schema carries
 * `followup_message` and nothing else — so the text it asserted was rendered into a field the host ignores. The
 * advisory is not lost, it is in the gate artifact, which is where an operator on that host reads it
 * ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("the docs advisory abstains on a provider whose stop event carries no context, and the artifact keeps it", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { docs: { command: FAILING_DOCS, severity: "warn" } });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
    const artifact = readFileSync(join(root, ".tlc", "harness", "state", "last-gate.json"), "utf8");
    assert.match(artifact, /"gate":\s*"docs"/);
    assert.match(artifact, /doc x is stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing docs command at deny blocks the stop through the standard gate path", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { docs: { command: FAILING_DOCS, severity: "deny" } });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /docs/);
    }
    // the shared path means the artifact and the handoff are written like any other gate
    const artifact = readFileSync(join(root, ".tlc", "harness", "state", "last-gate.json"), "utf8");
    assert.match(artifact, /"gate":\s*"docs"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no docs command means the gate does not run", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { docs: { command: null } });
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.notEqual(outcome.decision.kind, "context");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const PLAN_ON = { planGate: { enabled: true } };

async function declarePlan(root: string, text: string): Promise<void> {
  await runHandler(
    responseAfterHandler,
    stdinOf(
      JSON.stringify({
        hook_event_name: "afterAgentResponse",
        workspace_roots: [root],
        conversation_id: "conv-1",
        session_id: "sess-1",
        text,
      }),
    ),
  );
}

test("planGate off ignores an unplanned file", async () => {
  const root = repoWithChange();
  try {
    await declarePlan(root, "HARNESS_PLAN: nothing/real.ts");
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn with no declared plan is not gated", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, PLAN_ON);
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed file outside the declared plan blocks the stop and names it", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, PLAN_ON);
    await declarePlan(root, "HARNESS_PLAN: docs/only.md");
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /outside the declared plan/);
      assert.match(outcome.decision.text, /HARNESS_PLAN_DEVIATION/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a justified deviation lets the same stop through", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, PLAN_ON);
    await declarePlan(root, "HARNESS_PLAN: docs/only.md");
    const blocked = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(blocked.decision.kind, "continue");

    const changed = readFileSync(join(root, ".tlc", "harness", "state", "handoff.json"), "utf8");
    const parsed = JSON.parse(changed) as {
      by_provider: Record<string, { last_changed_files?: string[] }>;
    };
    const touched = parsed.by_provider.cursor?.last_changed_files ?? [];
    assert.ok(touched.length > 0);
    await declarePlan(root, `HARNESS_PLAN_DEVIATION: ${touched[0]} — the change belongs to this task`);

    const allowed = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(allowed.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the plan gate runs before the ship gate, since bad scope invalidates the evidence", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, {
      ...PLAN_ON,
      shipGate: { enabled: true, emptyDiffAntiShip: true, evidenceDir: null },
    });
    await declarePlan(root, "HARNESS_SHIP_CLAIM: done\nHARNESS_PLAN: docs/only.md");
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /outside the declared plan/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// hazard: `gate.outcome` was consumed by the rollup counter and by the session report's "Gates pass/fail" line,
// and emitted by nothing. Both read structurally zero, so the report printed a truthful-looking `0 / 0` for every
// gate this harness has ever run.
test("a failing gate records its outcome, and the counter that reads it moves", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, {
      version: 1,
      codePaths: ["src"],
      grind: { enabled: true, lintCommand: ["node", "-e", "process.exit(1)"] },
    });
    await runHandler(stopHandler, stdinOf(claudeStop(root)));

    const recorded = coreFacade.observability
      .readSignalEvents(root, "obs.jsonl", 50)
      .filter((event) => event.kind === "gate.outcome");
    assert.ok(recorded.length >= 1, "no gate outcome was recorded");
    assert.equal(recorded[0]?.attrs.passed, false);
    assert.equal(recorded[0]?.attrs.gate, "lint");

    const rollup = coreFacade.observability.getRollup(root, "claude-sess-1");
    assert.equal(rollup?.gates.fail, 1);
    assert.equal(rollup?.gates.pass, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a passing gate records a passing outcome", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, {
      version: 1,
      codePaths: ["src"],
      grind: { enabled: true, lintCommand: ["node", "-e", "process.exit(0)"] },
    });
    await runHandler(stopHandler, stdinOf(claudeStop(root)));

    const rollup = coreFacade.observability.getRollup(root, "claude-sess-1");
    assert.equal(rollup?.gates.pass, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: the reading that justifies deleting a rail. With the comment gate off and observation on, a narrating
// comment is measured without the rule being injected — which separates "the model already avoids this" from
// "the rule works". A firing rate alone cannot make that distinction.
test("observation records a violation while the rail is off, and the turn is untouched", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, {
      version: 1,
      codePaths: ["src"],
      comments: { enabled: false },
      observe: { enabled: true, rails: ["comments"] },
    });
    writeFileSync(join(root, "src", "app.ts"), "// increments the counter\nexport const a = 2;\n");
    git(root, ["add", "-A"]);

    const outcome = await runHandler(stopHandler, stdinOf(claudeStop(root)));

    const observed = coreFacade.observability
      .readSignalEvents(root, "obs.jsonl", 50)
      .filter((event) => event.kind === "policy.observe");
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.attrs.rail, "comments");
    assert.equal(observed[0]?.attrs.prose_injected, false);
    assert.equal(observed[0]?.attrs.reading, "violated-without-prose");

    // invariant: a measurement that can change what it measures is not a measurement.
    assert.notEqual(outcome.decision.kind, "continue");
    assert.equal(coreFacade.observability.getRollup(root, "claude-sess-1")?.denials, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation off leaves the turn byte-identical, and records nothing", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, { version: 1, codePaths: ["src"], comments: { enabled: false } });
    writeFileSync(join(root, "src", "app.ts"), "// increments the counter\nexport const a = 2;\n");
    git(root, ["add", "-A"]);

    await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(
      coreFacade.observability
        .readSignalEvents(root, "obs.jsonl", 50)
        .filter((event) => event.kind === "policy.observe").length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// invariant: an enforcing rail records through its own path. Observing it as well would double every reading.
test("an enforcing rail is not observed as well", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, {
      version: 1,
      codePaths: ["src"],
      comments: { enabled: true, onViolation: "followup" },
      observe: { enabled: true, rails: ["comments"] },
    });
    writeFileSync(join(root, "src", "app.ts"), "// increments the counter\nexport const a = 2;\n");
    git(root, ["add", "-A"]);

    const outcome = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    assert.equal(
      coreFacade.observability
        .readSignalEvents(root, "obs.jsonl", 50)
        .filter((event) => event.kind === "policy.observe").length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: the pairing of a failure with what resolved it is the one thing nothing else has, because nothing else
// holds a failure fingerprint and the diff in the same process. It used to be deleted at the exact moment it
// became true.
test("a resolved failure is remembered, and its recurrence is offered as history", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, {
      version: 1,
      codePaths: ["src"],
      grind: { enabled: true, lintCommand: ["node", "-e", "process.exit(1)"] },
    });
    const failing = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(failing.decision.kind, "continue");
    assert.doesNotMatch(failing.decision.kind === "continue" ? failing.decision.text : "", /History:/);

    // the gate now passes, and a file changed — that pair is what gets recorded
    writeProjectPolicy(root, {
      version: 1,
      codePaths: ["src"],
      grind: { enabled: true, lintCommand: ["node", "-e", "process.exit(0)"] },
    });
    await runHandler(stopHandler, stdinOf(claudeStop(root)));

    // the same failure returns
    writeProjectPolicy(root, {
      version: 1,
      codePaths: ["src"],
      grind: { enabled: true, lintCommand: ["node", "-e", "process.exit(1)"] },
    });
    const again = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    const text = again.decision.kind === "continue" ? again.decision.text : "";
    assert.match(text, /History:/);
    assert.match(text, /src\/app\.ts/);
    // invariant: history, never instruction.
    assert.match(text, /not a list to edit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure with no recorded resolution leaves the follow-up unchanged", async () => {
  const root = repoWithChange();
  try {
    writeProjectPolicy(root, ALWAYS_FAIL);
    const outcome = await runHandler(stopHandler, stdinOf(claudeStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    assert.doesNotMatch(outcome.decision.kind === "continue" ? outcome.decision.text : "", /History:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: the idle-turn rail wrote `blockers`, which is one of the four fields `unfinishedWork` reads. One firing
 * therefore manufactured its own precondition and it blocked every later turn regardless of what the agent did —
 * the operator saw the same BLOCKED four times in a row. The other half was an activity counter that could not
 * rise, so nothing ever cleared it ([/decisions/ad-059.md](/decisions/ad-059.md)).
 *
 * invariant: a rail records what it saw and never writes a field it reads.
 */
test("the idle-turn gate does not write the open work it reads", async () => {
  const root = cleanRepo();
  try {
    writeProjectPolicy(root, { intelligence: { idleTurnGate: true } });
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: { blockers: "something else set this" },
    });
    coreFacade.observability.recordObs(root, coreFacade.observability.DEFAULT_OBS, {
      provider: "cursor",
      kind: "prompt.submit",
      sessionKey: "cursor-conv-1",
    });

    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /ended with open work/);
    }

    // the blocker that armed it is untouched; the rail added none of its own
    const after = coreFacade.handoff.readHandoff(root, "cursor");
    assert.equal(after.blockers, "something else set this");
    assert.equal(after.next_action, "Attempt the work, or proceed under a stated assumption.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn that ran a tool is not idle, even when the tool succeeded", async () => {
  const root = cleanRepo();
  try {
    writeProjectPolicy(root, { intelligence: { idleTurnGate: true } });
    await coreFacade.handoff.patchHandoff(root, "cursor", { slice: { blockers: "open work" } });
    const obs = coreFacade.observability.DEFAULT_OBS;
    coreFacade.observability.recordObs(root, obs, {
      provider: "cursor",
      kind: "prompt.submit",
      sessionKey: "cursor-conv-1",
    });
    // why: a successful shell call resolves to the debug plane, and production writes that plane with
    // OBS_CONFIG_AUDIT, which forces debugEnabled on (support.ts). Recorded the same way here, because the
    // question is whether the counter reads the plane the work actually lands on.
    coreFacade.observability.recordObs(
      root,
      { ...obs, debugEnabled: true },
      {
        provider: "cursor",
        kind: "shell.end",
        sessionKey: "cursor-conv-1",
        attrs: { permission: "allow" },
      },
    );

    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(root)));
    const blocked =
      outcome.decision.kind === "continue" && /ended with open work/.test(outcome.decision.text);
    assert.equal(blocked, false, "a turn that ran a tool must not be reported as idle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: a mutant that dropped the bound and took the library's 120-second default survived every other test
 * here — it still deferred, so the assertions held and only the clock noticed. The hook's own registered timeout
 * is the number the wait has to fit inside, so the test reads it from the wiring rather than restating it.
 */
test("the lock wait leaves the Stop hook room to run the gate it waited for", () => {
  const stopEntry = claudeWiring({ launcherPath: "/opt/tlc/bin/tlc-exec.mjs" }).entries.find(
    (entry) => entry.hookEvent === "Stop",
  );
  assert.notEqual(stopEntry, undefined, "the Stop hook is registered");
  const budgetMs = (stopEntry?.timeoutSeconds ?? 0) * 1000;

  assert.equal(STOP_LOCK_WAIT_MS < budgetMs, true, `${STOP_LOCK_WAIT_MS}ms must fit inside ${budgetMs}ms`);
  // invariant: a wait that eats most of the budget starves the gate. A fifth leaves four fifths to run it.
  assert.equal(STOP_LOCK_WAIT_MS <= budgetMs / 5, true, "the wait may not claim most of the hook's budget");
  assert.equal(
    STOP_LOCK_WAIT_MS < coreFacade.gate.GATE_LOCK_WAIT_MS,
    true,
    "bounded below the library default",
  );

  // invariant: the seam only ever shortens the wait, and only when set.
  assert.equal(stopLockWaitMs({}), STOP_LOCK_WAIT_MS);
  assert.equal(stopLockWaitMs({ TLC_TEST_GATE_LOCK_WAIT_MS: "150" }), 150);
  assert.equal(stopLockWaitMs({ TLC_TEST_GATE_LOCK_WAIT_MS: "nonsense" }), STOP_LOCK_WAIT_MS);
  assert.equal(stopLockWaitMs({ TLC_TEST_GATE_LOCK_WAIT_MS: "0" }), STOP_LOCK_WAIT_MS);
});
