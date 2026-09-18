import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectConfigPath } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";
import { stopHandler } from "../stop.ts";

const cleanup: string[] = [];
const originalHome = process.env.TLC_HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = originalHome;
  }
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

/** A repository with uncommitted work in the tree — the shape the reported defect needed. */
function dirtyRepo(): string {
  const dir = newDir("tlc-cache-repo-");
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, ".gitignore"), ".tlc/\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 2;\n");
  return dir;
}

/**
 * why: a marker file the command appends to, so "did the suite run again" is a counted fact rather than a timing
 * guess. Nothing else in the harness can tell a cache hit from a very fast run.
 */
function countingGate(exitCode: number): { command: string[]; runs: () => number } {
  const marker = join(newDir("tlc-cache-marker-"), "runs.log");
  const command = [
    process.execPath,
    "-e",
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"); process.exit(${exitCode});`,
  ];
  return {
    command,
    runs: () => (existsSync(marker) ? readFileSync(marker, "utf8").length : 0),
  };
}

function writePolicy(root: string, lint: string[], extra: Record<string, unknown> = {}): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ version: 1, grind: { enabled: true, lintCommand: lint, maxLoops: 3 }, ...extra }),
    "utf8",
  );
}

function stopEvent(root: string, sessionId = "sess-cache"): { readStdin: () => Promise<string> } {
  return {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: sessionId, status: "completed" }),
      ),
  };
}

test("the first stop runs the gate and records the inputs hash", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  const gate = countingGate(0);
  writePolicy(root, gate.command);

  await runHandler(stopHandler, stopEvent(root));

  assert.equal(gate.runs(), 1);
  assert.ok(coreFacade.gate.readLastGate(root, "claude-sess-cache")?.inputsHash);
});

/**
 * The reported defect: a read-only question in a repository with uncommitted work ran the whole suite, because the
 * trigger read the state of the tree rather than what the turn did.
 */
test("a second stop with nothing changed does not run the gate again", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  const gate = countingGate(0);
  writePolicy(root, gate.command);

  await runHandler(stopHandler, stopEvent(root));
  await runHandler(stopHandler, stopEvent(root));
  await runHandler(stopHandler, stopEvent(root));

  assert.equal(gate.runs(), 1);
});

/**
 * AD-137 — the reported production incident, reproduced end to end: two concurrent sessions in the same
 * checkout, the exact condition that let one session's cached gate result surface as another's. Before this
 * record, `readLastGate(args.root)` took no session, so the second session's stop read the first session's
 * own artifact — same file, same inputsHash, same shared dirty tree — and reused it without ever running its
 * own gate. `gate.runs()` staying at 1 after two DIFFERENT sessions' stops is the old, buggy behavior; 2 is
 * the fix.
 */
test("a second, different session's stop never reuses the first session's cached verdict", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  const gate = countingGate(1);
  writePolicy(root, gate.command);

  const first = await runHandler(stopHandler, stopEvent(root, "sess-agent-a"));
  const second = await runHandler(stopHandler, stopEvent(root, "sess-agent-b"));

  assert.equal(
    gate.runs(),
    2,
    "each session must run its own gate — session B must never inherit session A's cached artifact",
  );
  assert.equal(first.decision.kind, "continue", "session A is blocked by its own real failure");
  assert.equal(second.decision.kind, "continue", "session B is blocked by ITS OWN real failure, not A's");

  const artifactA = coreFacade.gate.readLastGate(root, "claude-sess-agent-a");
  const artifactB = coreFacade.gate.readLastGate(root, "claude-sess-agent-b");
  assert.ok(artifactA, "session A must have its own artifact");
  assert.ok(artifactB, "session B must have its own artifact, not merely a read of A's");
});

/**
 * AD-137 (round 2) — the reported symptom itself, reproduced exactly: session B made no changes of its own,
 * but the shared working tree still shows session A's edit as "changed" from B's own point of view (`git
 * diff` has no concept of which agent wrote an uncommitted change). Before this record, B ran its own gate
 * against A's own file and blocked on A's own failure — same final BLOCKED text, different cause than the
 * first-round fix closed. Once session A's own presence record claims the file, session B's own gate scope
 * excludes it, and B's turn is not blocked by work that was never B's own.
 */
test("a session with no claim on the dirty file is not blocked by a live neighbour's own edit", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  const gate = countingGate(1);
  writePolicy(root, gate.command);

  // why: `run.ts` writes `event.filePath` verbatim, and every real host sends an absolute path — a relative
  // claim here would test a shape production never produces.
  coreFacade.presence.register(root, { provider: "claude", session: "sess-agent-a", pid: 1, branch: "main" });
  coreFacade.presence.heartbeat(root, {
    provider: "claude",
    session: "sess-agent-a",
    file: join(root, "src", "app.ts"),
  });

  const outcome = await runHandler(stopHandler, stopEvent(root, "sess-agent-b"));

  assert.equal(
    gate.runs(),
    0,
    "session B must never run a gate scoped to a file only session A's own presence record claims",
  );
  if (outcome.decision.kind === "continue") {
    assert.doesNotMatch(outcome.decision.text, /BLOCKED: lint failed/);
  }
});

test("a content change runs the gate again", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  const gate = countingGate(0);
  writePolicy(root, gate.command);

  await runHandler(stopHandler, stopEvent(root));
  writeFileSync(join(root, "src", "app.ts"), "export const a = 3;\n");
  await runHandler(stopHandler, stopEvent(root));

  assert.equal(gate.runs(), 2);
});

// invariant: a fresh failing run blocks, exactly as before.
test("a fresh failure still blocks the stop", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  writePolicy(root, countingGate(1).command);

  const outcome = await runHandler(stopHandler, stopEvent(root));

  assert.equal(outcome.decision.kind, "continue");
  assert.match(outcome.decision.kind === "continue" ? outcome.decision.text : "", /^BLOCKED: lint failed/);
});

/**
 * invariant: the cache changes only whether the command executes. A reused failure still blocks, still advances the
 * fingerprint and still grades lessons — making it advisory instead was tried and the suite caught that it silences
 * the stagnation rail, whose whole purpose is an agent that changes nothing
 * ([/decisions/ad-045.md](/decisions/ad-045.md)).
 */
test("a reused failure still blocks, without running the command again", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  const gate = countingGate(1);
  writePolicy(root, gate.command);

  const first = await runHandler(stopHandler, stopEvent(root));
  assert.equal(first.decision.kind, "continue");

  const second = await runHandler(stopHandler, stopEvent(root));
  assert.equal(second.decision.kind, "continue");
  assert.equal(gate.runs(), 1);
});

// invariant: the rail that exists for an agent that changes nothing must still fire when the agent changes nothing.
test("a reused failure still advances the stagnation counter", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  writePolicy(root, countingGate(1).command);

  await runHandler(stopHandler, stopEvent(root));
  const afterFirst = coreFacade.stagnation.fingerprintHits(root, "claude-sess-cache");
  const second = await runHandler(stopHandler, stopEvent(root));

  assert.ok(coreFacade.stagnation.fingerprintHits(root, "claude-sess-cache") > afterFirst);
  assert.match(
    second.decision.kind === "continue" ? second.decision.text : "",
    /identical validation fingerprint repeated/i,
  );
});

/**
 * hazard: an incomplete hash is computed over the entries it could read, so a tracked-but-deleted file hashes to the
 * same value the remaining files alone would produce. Recording it would let a later complete run collide with a
 * verdict produced without seeing every input ([/decisions/ad-045.md](/decisions/ad-045.md)).
 */
test("an unreadable input is never cached, so the gate runs every time", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  const gate = countingGate(0);
  writePolicy(root, gate.command);
  // why: tracked and deleted, so git reports it as changed and the filesystem cannot read it.
  writeFileSync(join(root, "src", "gone.ts"), "export const gone = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-qm", "add"], { cwd: root });
  rmSync(join(root, "src", "gone.ts"));

  await runHandler(stopHandler, stopEvent(root));
  await runHandler(stopHandler, stopEvent(root));

  assert.equal(coreFacade.gate.readLastGate(root, "claude-sess-cache")?.inputsHash, undefined);
  assert.equal(gate.runs(), 2);
});

test("a reused pass is silent", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  writePolicy(root, countingGate(0).command);

  await runHandler(stopHandler, stopEvent(root));
  const second = await runHandler(stopHandler, stopEvent(root));

  assert.equal(second.decision.kind, "abstain");
});

/**
 * why: a reused failure is still the gate's answer for this turn, so the lessons injected for it are graded. The
 * alternative — withholding the grade — was rejected with the advisory: both hinge on treating a reused verdict as
 * a non-event, and it is not, because the agent still ended a turn with that gate failing.
 */
test("a reused failure grades the lessons injected for that gate", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  writePolicy(root, countingGate(1).command, { intelligence: { lessons: { enabled: true } } });
  const seeded = await coreFacade.lesson.upsertProjectLesson(
    root,
    coreFacade.lesson.buildAuthoredLesson({ instruction: "Read the finding first.", gate: "lint" }),
  );

  await runHandler(stopHandler, stopEvent(root));
  await runHandler(stopHandler, stopEvent(root));

  const graded = coreFacade.lesson.readProjectLessons(root).find((l) => l.id === seeded.id);
  assert.equal(graded?.neutralCount, 1);
  assert.equal(graded?.helpedCount, 0);
});

test("the recorded outcome says whether the verdict was reused", async () => {
  process.env.TLC_HOME = newDir("tlc-cache-home-");
  const root = dirtyRepo();
  writePolicy(root, countingGate(0).command);

  await runHandler(stopHandler, stopEvent(root));
  await runHandler(stopHandler, stopEvent(root));

  const outcomes = coreFacade.observability
    .readSignalEvents(root, "obs.jsonl", 200)
    .filter((event) => event.kind === "gate.outcome");
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.attrs.reused, false);
  assert.equal(outcomes[1]?.attrs.reused, true);
});
