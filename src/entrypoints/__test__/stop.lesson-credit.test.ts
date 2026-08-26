import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectConfigPath } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";
import { stopHandler } from "../stop.ts";
import { renderLessonLine } from "../support.ts";

/**
 * The one thing unit tests cannot show: that the credit is actually wired into the stop path. `creditLessons` and
 * `selectLessons` each have their own tests and both pass while nothing joins them
 * ([/decisions/ad-039.md](/decisions/ad-039.md)).
 */
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

function repoWithChange(): string {
  const dir = newDir("tlc-credit-repo-");
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

function writePolicy(root: string, lint: string[]): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      grind: { enabled: true, lintCommand: lint, maxLoops: 5 },
      intelligence: { lessons: { enabled: true } },
    }),
    "utf8",
  );
}

function stopEvent(root: string, sessionId = "sess-credit"): { readStdin: () => Promise<string> } {
  return {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          hook_event_name: "Stop",
          cwd: root,
          session_id: sessionId,
          status: "completed",
        }),
      ),
  };
}

const FAIL = ["node", "-e", "process.exit(1)"];
const PASS = ["node", "-e", ""];

function projectLesson(root: string, id: string) {
  return coreFacade.lesson.readProjectLessons(root).find((lesson) => lesson.id === id);
}

async function seedInjectableLesson(root: string): Promise<string> {
  const lesson = coreFacade.lesson.buildAuthoredLesson({
    instruction: "Read the failing assertion before editing.",
    gate: "lint",
  });
  const saved = await coreFacade.lesson.upsertProjectLesson(root, lesson);
  return saved.id;
}

/**
 * hazard: `support.ts` carried a copy of the core renderer, so the tier added to the core block appeared in
 * `lessons list` and in nothing the model ever saw. Asserting the rendered core block is not enough — this
 * asserts the text the hook returns ([/decisions/ad-040.md](/decisions/ad-040.md)).
 */
test("the tier reaches the text the model receives, not only the CLI", async () => {
  process.env.TLC_HOME = newDir("tlc-credit-home-");
  const root = repoWithChange();
  writePolicy(root, FAIL);
  await seedInjectableLesson(root);

  const outcome = await runHandler(stopHandler, stopEvent(root));
  const text = outcome.decision.kind === "continue" ? outcome.decision.text : "";

  assert.match(text, /\[lint\/active\/project\]/);
  assert.match(text, /\[lint\/active\/core\]/);
});

// invariant: one renderer. Two derivations of the same string is how the tier went missing from half of them.
test("the hook and the core render a lesson identically", () => {
  const lesson = coreFacade.lesson.buildAuthoredLesson({ instruction: "Read it.", gate: "lint" });
  assert.equal(renderLessonLine(lesson), coreFacade.lesson.renderLessonBlock(lesson));
  assert.match(renderLessonLine(lesson), /\/project\]/);
});

test("a failing gate records which lessons it injected, for that gate", async () => {
  process.env.TLC_HOME = newDir("tlc-credit-home-");
  const root = repoWithChange();
  writePolicy(root, FAIL);
  const id = await seedInjectableLesson(root);

  await runHandler(stopHandler, stopEvent(root));

  const handoff = coreFacade.handoff.readHandoff(root, "claude");
  assert.equal(handoff.pending_lesson_credit?.gate, "lint");
  assert.ok(handoff.pending_lesson_credit?.ids.includes(id));
  assert.equal(projectLesson(root, id)?.injectedCount, 1);
});

// invariant: the gate that was failing then passing is what grades the lessons chosen for it.
test("the gate passing on the next stop credits those lessons as helped", async () => {
  process.env.TLC_HOME = newDir("tlc-credit-home-");
  const root = repoWithChange();
  writePolicy(root, FAIL);
  const id = await seedInjectableLesson(root);
  await runHandler(stopHandler, stopEvent(root));
  assert.equal(projectLesson(root, id)?.helpedCount, 0);

  writePolicy(root, PASS);
  await runHandler(stopHandler, stopEvent(root));

  const graded = projectLesson(root, id);
  assert.equal(graded?.helpedCount, 1);
  assert.equal(graded?.neutralCount, 0);
  assert.equal(coreFacade.lesson.lessonEffectiveness(graded ?? ({} as never)), "helped");
});

test("the gate failing again credits those lessons as neutral", async () => {
  process.env.TLC_HOME = newDir("tlc-credit-home-");
  const root = repoWithChange();
  writePolicy(root, FAIL);
  const id = await seedInjectableLesson(root);
  await runHandler(stopHandler, stopEvent(root));

  await runHandler(stopHandler, stopEvent(root));

  const graded = projectLesson(root, id);
  assert.equal(graded?.neutralCount, 1);
  assert.equal(graded?.helpedCount, 0);
});

// invariant: consumed exactly once, so one injection cannot be graded twice by two later runs of the same gate.
test("a credit is consumed once", async () => {
  process.env.TLC_HOME = newDir("tlc-credit-home-");
  const root = repoWithChange();
  writePolicy(root, FAIL);
  const id = await seedInjectableLesson(root);
  await runHandler(stopHandler, stopEvent(root));

  writePolicy(root, PASS);
  await runHandler(stopHandler, stopEvent(root));
  await runHandler(stopHandler, stopEvent(root));

  assert.equal(projectLesson(root, id)?.helpedCount, 1);
  assert.equal(coreFacade.handoff.readHandoff(root, "claude").pending_lesson_credit, undefined);
});

// hazard: without comparing the gate name, lessons injected for `lint` would be graded by whichever gate ran next.
test("a lesson injected for one gate is not credited by a different gate", async () => {
  process.env.TLC_HOME = newDir("tlc-credit-home-");
  const root = repoWithChange();
  writePolicy(root, FAIL);
  const id = await seedInjectableLesson(root);
  await runHandler(stopHandler, stopEvent(root));

  // why: lint is removed and only a passing test gate remains, so the next stop runs a gate the credit is not for.
  const path = projectConfigPath(root);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      grind: { enabled: true, testCommand: PASS, maxLoops: 5 },
      intelligence: { lessons: { enabled: true } },
    }),
    "utf8",
  );
  await runHandler(stopHandler, stopEvent(root));

  const ungraded = projectLesson(root, id);
  assert.equal(ungraded?.helpedCount, 0);
  assert.equal(ungraded?.neutralCount, 0);
});

// hazard: pending_lesson_credit lives on the same per-project handoff `blockers` does — without a
// session check, a different session passing the same gate would credit a lesson it never saw.
test("a lesson injected by one session is not credited by a different session", async () => {
  process.env.TLC_HOME = newDir("tlc-credit-home-");
  const root = repoWithChange();
  writePolicy(root, FAIL);
  const id = await seedInjectableLesson(root);
  await runHandler(stopHandler, stopEvent(root, "sess-a"));

  writePolicy(root, PASS);
  await runHandler(stopHandler, stopEvent(root, "sess-b"));

  const graded = projectLesson(root, id);
  assert.equal(graded?.helpedCount, 0);
  assert.equal(graded?.neutralCount, 0);
  assert.equal(coreFacade.handoff.readHandoff(root, "claude").pending_lesson_credit?.ids.includes(id), true);
});

// invariant: the originating session still credits normally once it is the one that grades the gate.
test("the same session that injected a lesson still credits it", async () => {
  process.env.TLC_HOME = newDir("tlc-credit-home-");
  const root = repoWithChange();
  writePolicy(root, FAIL);
  const id = await seedInjectableLesson(root);
  await runHandler(stopHandler, stopEvent(root, "sess-a"));

  writePolicy(root, PASS);
  await runHandler(stopHandler, stopEvent(root, "sess-a"));

  assert.equal(projectLesson(root, id)?.helpedCount, 1);
});

// invariant: a stale lesson must not reach the turn, and therefore must not be graded either.
test("a stale lesson is neither injected nor credited", async () => {
  process.env.TLC_HOME = newDir("tlc-credit-home-");
  const root = repoWithChange();
  writePolicy(root, FAIL);
  const lesson = coreFacade.lesson.buildAuthoredLesson({
    instruction: "Run the renamed checker before the commit.",
    gate: "lint",
    refs: [{ path: "tools/gone.ts" }],
  });
  const saved = await coreFacade.lesson.upsertProjectLesson(root, {
    ...lesson,
    staleReason: "path-missing",
  });

  await runHandler(stopHandler, stopEvent(root));

  const handoff = coreFacade.handoff.readHandoff(root, "claude");
  assert.equal(handoff.pending_lesson_credit?.ids.includes(saved.id) ?? false, false);
  assert.equal(projectLesson(root, saved.id)?.injectedCount, 0);
});
