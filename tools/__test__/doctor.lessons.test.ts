import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { coreFacade, type HarnessLesson } from "../../src/core/index.ts";
import { upsertGlobalLesson, upsertProjectLesson } from "../../src/core/lesson/lesson.store.ts";
import { checkLessonBudget, checkLessonHealth, plural } from "../doctor.ts";

const NOW = "2026-08-04T12:00:00.000Z";
const cleanup: string[] = [];
const originalHome = process.env.TLC_HOME;

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function projectWithLessonsOn(): string {
  const root = newDir("tlc-doctor-lessons-");
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  writeFileSync(
    join(root, ".tlc", "harness", "config.json"),
    JSON.stringify({ version: 1, intelligence: { lessons: { enabled: true } } }),
    "utf8",
  );
  return root;
}

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

function lesson(overrides: Partial<HarnessLesson> = {}): HarnessLesson {
  return {
    id: "project:test:abc",
    scope: "gate-execution",
    failedGate: "test",
    category: "verification",
    triggerTokens: [],
    instruction: "read the assertion",
    avoid: "",
    prefer: "",
    preRetryCheck: "",
    source: "project",
    tier: "project",
    status: "active",
    confidence: 0.9,
    hitCount: 2,
    priority: 50,
    pinned: false,
    refs: [],
    sessionKeys: ["s-1", "s-2"],
    injectedCount: 0,
    gradeableCount: 0,
    helpedCount: 0,
    neutralCount: 0,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastAccessedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test("a person's plural, so no operator reads '1 lesson(s)'", () => {
  assert.equal(plural(1, "lesson"), "1 lesson");
  assert.equal(plural(0, "lesson"), "0 lessons");
  assert.equal(plural(2, "lesson"), "2 lessons");
});

// why: silent when the capability is off. A row about a disabled feature is noise on every healthy run.
test("nothing is reported when lessons are disabled", () => {
  process.env.TLC_HOME = newDir("tlc-doctor-home-");
  assert.deepEqual(checkLessonHealth(newDir("tlc-doctor-off-")), []);
});

test("nothing is reported when the writable tiers are empty", () => {
  process.env.TLC_HOME = newDir("tlc-doctor-home-");
  assert.deepEqual(checkLessonHealth(projectWithLessonsOn()), []);
});

test("a healthy store reports one ok row naming the count", async () => {
  process.env.TLC_HOME = newDir("tlc-doctor-home-");
  const root = projectWithLessonsOn();
  await upsertProjectLesson(root, lesson());
  const checks = checkLessonHealth(root);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.level, "ok");
  assert.match(checks[0]?.detail ?? "", /1 lesson across the writable tiers/);
});

test("a stale lesson is a warning that names it and the command to see it", async () => {
  process.env.TLC_HOME = newDir("tlc-doctor-home-");
  const root = projectWithLessonsOn();
  await upsertProjectLesson(root, lesson({ staleReason: "path-missing" }));
  const checks = checkLessonHealth(root);
  const stale = checks.find((check) => check.name === "stale lessons");
  assert.equal(stale?.level, "warn");
  assert.match(stale?.detail ?? "", /project:test:abc/);
  assert.match(stale?.detail ?? "", /tlc harness lessons list/);
});

test("an expired lesson is a warning pointing at garden", async () => {
  process.env.TLC_HOME = newDir("tlc-doctor-home-");
  const root = projectWithLessonsOn();
  await upsertProjectLesson(root, lesson({ validTo: "2026-01-01T00:00:00.000Z" }));
  const checks = checkLessonHealth(root);
  const window = checks.find((check) => check.name === "lessons out of window");
  assert.equal(window?.level, "warn");
  assert.match(window?.detail ?? "", /tlc harness lessons garden/);
});

// invariant: unproven is a warning, not an ok row. A lesson nothing has tested is spending injected context on an
// unjustified claim.
test("a lesson injected and never graded is a warning, not a healthy row", async () => {
  process.env.TLC_HOME = newDir("tlc-doctor-home-");
  const root = projectWithLessonsOn();
  await upsertProjectLesson(root, lesson({ injectedCount: 3, gradeableCount: 3 }));
  const checks = checkLessonHealth(root);
  assert.equal(
    checks.some((check) => check.level === "ok"),
    false,
  );
  const unproven = checks.find((check) => check.name === "unproven lessons");
  assert.equal(unproven?.level, "warn");
  assert.match(unproven?.detail ?? "", /never graded/);
});

// why: a lesson that has never been injected cannot be unproven — there is nothing to have measured yet.
test("a lesson that was never injected is not reported as unproven", async () => {
  process.env.TLC_HOME = newDir("tlc-doctor-home-");
  const root = projectWithLessonsOn();
  await upsertProjectLesson(root, lesson({ injectedCount: 0 }));
  assert.equal(
    checkLessonHealth(root).some((check) => check.name === "unproven lessons"),
    false,
  );
});

test("a graded lesson is not reported as unproven", async () => {
  process.env.TLC_HOME = newDir("tlc-doctor-home-");
  const root = projectWithLessonsOn();
  await upsertProjectLesson(
    root,
    lesson({ injectedCount: 3, gradeableCount: 3, helpedCount: 1, neutralCount: 2 }),
  );
  const checks = checkLessonHealth(root);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.level, "ok");
});

test("the global tier is counted alongside the project tier", async () => {
  process.env.TLC_HOME = newDir("tlc-doctor-home-");
  const root = projectWithLessonsOn();
  await upsertGlobalLesson(lesson({ id: "manual:global" }));
  const checks = checkLessonHealth(root);
  assert.match(checks[0]?.detail ?? "", /1 lesson across the writable tiers/);
});

/**
 * hazard: the char budget drops lessons, and the only place that said so was the injected block — text the model
 * reads and the operator never sees. `lessons list` answers a different question (`not-injected` is grading
 * history, not the budget) and `status` does not answer it at all. Measured on this repository the day it was
 * added: 4 of 6 lessons never reached the model, and nothing said so
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
function projectWithBudget(maxChars: number, maxCount = 5): string {
  const root = newDir("tlc-doctor-budget-");
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  writeFileSync(
    join(root, ".tlc", "harness", "config.json"),
    JSON.stringify({
      version: 1,
      intelligence: {
        lessons: { enabled: true, maxCharsSession: maxChars, maxInjectSession: maxCount },
      },
    }),
    "utf8",
  );
  process.env.TLC_HOME = newDir("tlc-doctor-budget-home-");
  return root;
}

const LONG = "x".repeat(300);

/**
 * why the counts are not hard-coded: the shipped core lessons compete for the same budget, so an assertion on an
 * absolute total would break the day a core lesson is added. Measured while writing this: 3 project lessons read
 * as 7 ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
function omittedFrom(detail: string): { count: number; verb: string } {
  const match = /(\d+) eligible lessons? (never reaches|never reach)/.exec(detail);
  assert.ok(match, `no omitted clause in: ${detail}`);
  return { count: Number(match[1]), verb: String(match[2]) };
}

test("a budget that fits everything says so and names no fault", async () => {
  const root = projectWithBudget(20_000, 50);
  await upsertProjectLesson(root, lesson({ id: "project:a", instruction: "keep it short" }));

  const rows = checkLessonBudget(root);

  assert.equal(rows[0]?.level, "ok");
  assert.match(rows[0]?.detail ?? "", /every eligible lesson reaches the model/);
});

test("a lesson the budget drops is reported to the operator, with the numbers", async () => {
  const root = projectWithBudget(400);
  await upsertProjectLesson(root, lesson({ id: "project:a", instruction: LONG }));
  await upsertProjectLesson(root, lesson({ id: "project:b", instruction: LONG }));
  await upsertProjectLesson(root, lesson({ id: "project:c", instruction: LONG }));

  const row = checkLessonBudget(root)[0];

  assert.equal(row?.level, "warn");
  assert.ok(omittedFrom(row?.detail ?? "").count > 0);
  assert.match(row?.detail ?? "", /\d+ of \d+ fit in maxCharsSession 400 \(\d+ used\)/);
  assert.match(row?.detail ?? "", /Raise intelligence\.lessons\.maxCharsSession/);
});

/** invariant: the verb agrees with the count. `plural` handles the noun and nothing else. */
test("the verb agrees with however many were dropped", async () => {
  const root = projectWithBudget(400);
  await upsertProjectLesson(root, lesson({ id: "project:a", instruction: LONG }));

  const { count, verb } = omittedFrom(checkLessonBudget(root)[0]?.detail ?? "");

  assert.equal(verb, count === 1 ? "never reaches" : "never reach");
});

/** and the singular branch is reached by capping the count one below whatever is eligible. */
test("exactly one dropped lesson reads as one", async () => {
  const root = projectWithBudget(20_000, 50);
  await upsertProjectLesson(root, lesson({ id: "project:a", instruction: "short" }));
  const eligible = coreFacade.lesson.previewLessonSelection({
    projectDir: root,
    config: { ...coreFacade.policy.loadPolicy(root).intelligence.lessons },
    mode: "session",
  }).lessons.length;

  const capped = projectWithBudget(20_000, eligible - 1);
  await upsertProjectLesson(capped, lesson({ id: "project:a", instruction: "short" }));

  assert.deepEqual(omittedFrom(checkLessonBudget(capped)[0]?.detail ?? ""), {
    count: 1,
    verb: "never reaches",
  });
});

/** why named: a pinned lesson goes ahead of everything scored, so it is the one that took the room. */
test("a pinned lesson that took the room is named", async () => {
  const root = projectWithBudget(400);
  await upsertProjectLesson(root, lesson({ id: "project:pinned", instruction: LONG, pinned: true }));
  await upsertProjectLesson(root, lesson({ id: "project:b", instruction: LONG }));

  const detail = checkLessonBudget(root)[0]?.detail ?? "";

  assert.match(detail, /Pinned lessons go first and take the room: project:pinned \(pinned, \d+ chars\)/);
});

test("nothing is said when the capability is off", async () => {
  const root = newDir("tlc-doctor-budget-off-");
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  writeFileSync(
    join(root, ".tlc", "harness", "config.json"),
    JSON.stringify({ version: 1, intelligence: { lessons: { enabled: false } } }),
    "utf8",
  );

  assert.deepEqual(checkLessonBudget(root), []);
});

/**
 * invariant: reporting must not become injecting. `selectLessons` marks the picked lessons as accessed, which is
 * correct at an injection and wrong here — a measurement that changes what it measures is not a measurement
 * ([/decisions/ad-027.md](/decisions/ad-027.md)).
 */
test("asking what would be injected does not mark anything as accessed", async () => {
  const root = projectWithBudget(20_000);
  await upsertProjectLesson(
    root,
    lesson({ id: "project:a", instruction: "short", lastAccessedAt: undefined }),
  );

  checkLessonBudget(root);
  checkLessonBudget(root);

  const stored = readFileSync(join(root, ".tlc", "harness", "state", "lessons.json"), "utf8");
  assert.doesNotMatch(stored, /lastAccessedAt/);
});
