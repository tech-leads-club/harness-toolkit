import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateJsonAtomic } from "../../platform/fs-atomic.ts";
import { projectStateDir, runtimeStateDir } from "../../platform/paths.ts";
import { divergedMessage, seal, shouldInject, verifySeal } from "../integrity/state-seal.ts";
import { creditLesson, type LessonVerdict } from "./lesson.credit.ts";
import type { HarnessLesson, LessonStoreFile, LessonTier } from "./lesson.types.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";

type CoreLessonInput = Pick<
  HarnessLesson,
  | "id"
  | "failedGate"
  | "category"
  | "triggerTokens"
  | "instruction"
  | "avoid"
  | "prefer"
  | "preRetryCheck"
  | "priority"
>;

function coreLesson(input: CoreLessonInput): HarnessLesson {
  return {
    ...input,
    scope: "gate-execution",
    source: "core",
    tier: "core",
    status: "active",
    confidence: 1,
    hitCount: 1,
    pinned: false,
    refs: [],
    sessionKeys: [],
    injectedCount: 0,
    gradeableCount: 0,
    helpedCount: 0,
    neutralCount: 0,
    firstSeenAt: EPOCH,
    lastSeenAt: EPOCH,
    lastAccessedAt: EPOCH,
    updatedAt: EPOCH,
  };
}

export const CORE_LESSONS: readonly HarnessLesson[] = [
  coreLesson({
    id: "core:gate:lint",
    failedGate: "lint",
    category: "verification",
    triggerTokens: ["lint", "biome", "eslint", "ruff", "format"],
    instruction:
      "A lint gate failure means changed files still violate the project lint command. Fix the reported findings without suppressions.",
    avoid: "Do not add lint suppressions, disable comments, or delete failing files to silence the gate.",
    prefer: "Apply the smallest fix that clears each finding, then let the stop hook re-check.",
    preRetryCheck:
      "Confirm the lint command targets only the intended changed files and still fails for the same codes.",
    priority: 90,
  }),
  coreLesson({
    id: "core:gate:test",
    failedGate: "test",
    category: "verification",
    triggerTokens: ["test", "vitest", "jest", "pytest", "failing"],
    instruction:
      "A test gate failure means assertions still fail. Fix the behavior or the test under the real contract — do not delete or skip tests.",
    avoid: "Do not delete failing tests, mark them skipped, or weaken assertions to force green.",
    prefer: "Reproduce the failure, fix root cause, re-run the same test target.",
    preRetryCheck: "Identify the failing test name/file from the gate output before editing.",
    priority: 90,
  }),
  coreLesson({
    id: "core:gate:comments",
    failedGate: "comments",
    category: "verification",
    triggerTokens: ["junk comment", "TODO", "FIXME", "banner"],
    instruction:
      "Junk-comment policy failed. Delete narrating comments, banners, TODO/FIXME, and commented-out code.",
    avoid: "Do not keep TODO markers or section banners 'for clarity'.",
    prefer: "Keep only comments that explain a non-obvious why (invariant, hazard, external constraint).",
    preRetryCheck: "Scan the listed file:line hits and remove each one.",
    priority: 80,
  }),
  coreLesson({
    id: "core:gate:ship",
    failedGate: "ship",
    category: "ship-evidence",
    triggerTokens: ["ship", "evidence", "90-verdict", "PASS"],
    instruction:
      "Ship claim without recent production PASS evidence. Produce real evidence before claiming done.",
    avoid: "Do not claim shipped based on unit tests alone when runtime paths changed.",
    prefer: "Run production E2E, write 90-verdict.txt PASS, cite the evidence path.",
    preRetryCheck: "Confirm evidenceDir and a recent PASS verdict exist for this change.",
    priority: 95,
  }),
  coreLesson({
    id: "core:gate:empty-diff",
    failedGate: "empty-diff",
    category: "ship-evidence",
    triggerTokens: ["empty", "diff", "no changes", "shipped"],
    instruction:
      "Done/shipped was claimed with zero file changes. Either implement the work or explain why zero-diff is correct — do not claim shipped on an empty tree.",
    avoid: "Do not restate 'done' without a real diff or an explicit zero-change justification.",
    prefer: "Make the missing change, or clearly document why no files should change.",
    preRetryCheck: "Inspect git status / changed files before the next stop.",
    priority: 92,
  }),
  coreLesson({
    id: "core:gate:stagnation",
    failedGate: "stagnation",
    category: "stagnation",
    triggerTokens: ["stagnation", "identical", "fingerprint", "same fail"],
    instruction:
      "Identical validation fingerprint repeated. Change approach — do not re-apply the same failing edit.",
    avoid: "Do not retry the exact same patch, command, or suppression.",
    prefer: "Diagnose root cause with a different path, or escalate with BLOCKED / TRIED / NEED.",
    preRetryCheck: "Diff your last edit against the gate output; ensure the next action is different.",
    priority: 100,
  }),
];

export function lessonsStorePath(root: string): string {
  return join(projectStateDir(root), "lessons.json");
}

// why: one store for every repository on the machine. The per-repo store stays authoritative for this
// repository; this is the tier that follows the operator across products ([/decisions/ad-040.md](/decisions/ad-040.md)).
export function globalLessonsStorePath(): string {
  return join(runtimeStateDir(), "lessons.json");
}

function storePathFor(root: string, tier: Exclude<LessonTier, "core">): string {
  return tier === "global" ? globalLessonsStorePath() : lessonsStorePath(root);
}

// hazard: a record written before a field existed reads as `undefined`, and `undefined` propagated into
// `hitCount + 1` or `refs.length` throws or poisons a comparator. Every read normalizes, so no consumer has to.
function normalizeLesson(raw: HarnessLesson, tier: LessonTier): HarnessLesson {
  return {
    ...raw,
    tier,
    pinned: raw.pinned === true,
    refs: Array.isArray(raw.refs) ? raw.refs : [],
    sessionKeys: Array.isArray(raw.sessionKeys) ? raw.sessionKeys : [],
    injectedCount: Number.isFinite(raw.injectedCount) ? raw.injectedCount : 0,
    gradeableCount: Number.isFinite(raw.gradeableCount) ? raw.gradeableCount : 0,
    helpedCount: Number.isFinite(raw.helpedCount) ? raw.helpedCount : 0,
    neutralCount: Number.isFinite(raw.neutralCount) ? raw.neutralCount : 0,
  };
}

function readStore(path: string, tier: LessonTier): HarnessLesson[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as LessonStoreFile;
    return Array.isArray(file.lessons) ? file.lessons.map((lesson) => normalizeLesson(lesson, tier)) : [];
  } catch {
    return [];
  }
}

/**
 * why: the project store only. The global store is written by sessions in other repositories, so a per-project
 * seal would diverge on every legitimate cross-project write ([/decisions/ad-078.md](/decisions/ad-078.md)).
 */
export function projectLessonsInjectable(root: string): { ok: boolean; note: string | null } {
  const target = lessonsStorePath(root);
  const verdict = verifySeal(target);
  return shouldInject(verdict)
    ? { ok: true, note: null }
    : { ok: false, note: divergedMessage(target, "The project lesson store") };
}

export function readProjectLessons(root: string): HarnessLesson[] {
  return readStore(lessonsStorePath(root), "project");
}

export function readGlobalLessons(): HarnessLesson[] {
  return readStore(globalLessonsStorePath(), "global");
}

// invariant: the nearer tier wins on a duplicate id. A project that has taken a global lesson and rewritten it
// reads its own version, and the same lesson is never injected twice.
export function allLessons(root: string): HarnessLesson[] {
  const byId = new Map<string, HarnessLesson>();
  for (const lesson of [...CORE_LESSONS, ...readGlobalLessons(), ...readProjectLessons(root)]) {
    byId.set(lesson.id, lesson);
  }
  return [...byId.values()];
}

async function mutateStore(
  path: string,
  tier: LessonTier,
  mutate: (current: HarnessLesson[]) => HarnessLesson[],
): Promise<HarnessLesson[]> {
  const file = await updateJsonAtomic<LessonStoreFile>(
    path,
    (current) => {
      const lessons = current && Array.isArray(current.lessons) ? current.lessons : [];
      return { version: 1, lessons: mutate(lessons.map((lesson) => normalizeLesson(lesson, tier))) };
    },
    { lockPath: `${path}.lock`, afterWrite: seal },
  );
  return file.lessons;
}

export async function writeProjectLessons(root: string, lessons: HarnessLesson[]): Promise<void> {
  await mutateStore(lessonsStorePath(root), "project", () => lessons);
}

function upsert(lessons: HarnessLesson[], lesson: HarnessLesson): HarnessLesson[] {
  const index = lessons.findIndex((item) => item.id === lesson.id);
  if (index < 0) {
    return [...lessons, lesson];
  }
  const next = [...lessons];
  next[index] = lesson;
  return next;
}

export async function upsertProjectLesson(root: string, lesson: HarnessLesson): Promise<HarnessLesson> {
  const saved = { ...lesson, tier: "project" as const };
  await mutateStore(lessonsStorePath(root), "project", (current) => upsert(current, saved));
  return saved;
}

export async function upsertGlobalLesson(lesson: HarnessLesson): Promise<HarnessLesson> {
  const saved = { ...lesson, tier: "global" as const };
  await mutateStore(globalLessonsStorePath(), "global", (current) => upsert(current, saved));
  return saved;
}

export async function upsertLesson(
  root: string,
  lesson: HarnessLesson,
  tier: Exclude<LessonTier, "core">,
): Promise<HarnessLesson> {
  return tier === "global" ? upsertGlobalLesson(lesson) : upsertProjectLesson(root, lesson);
}

async function mutateWritableTiers(
  root: string,
  ids: readonly string[],
  patch: (lesson: HarnessLesson) => HarnessLesson,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const idSet = new Set(ids);
  // why: an injected set can span both writable tiers, so both are visited. Core is skipped because it is
  // shipped and identical everywhere — a counter on it would be a per-machine edit to a constant.
  for (const tier of ["project", "global"] as const) {
    const path = storePathFor(root, tier);
    if (!existsSync(path)) {
      continue;
    }
    await mutateStore(path, tier, (current) =>
      current.map((lesson) => (idSet.has(lesson.id) ? patch(lesson) : lesson)),
    );
  }
}

export async function touchAccessed(root: string, ids: string[], now = new Date()): Promise<void> {
  const iso = now.toISOString();
  await mutateWritableTiers(root, ids, (lesson) => ({
    ...lesson,
    lastAccessedAt: iso,
    updatedAt: iso,
    injectedCount: lesson.injectedCount + 1,
  }));
}

/**
 * Marks an injection as one a later gate run can grade.
 *
 * why: called where the pending credit is written, so the counter and the credit cannot disagree. Counting it at
 * injection time instead would include session-start injections, which nothing ever grades
 * ([/decisions/ad-044.md](/decisions/ad-044.md)).
 */
export async function markGradeable(root: string, ids: readonly string[], now = new Date()): Promise<void> {
  const iso = now.toISOString();
  await mutateWritableTiers(root, ids, (lesson) => ({
    ...lesson,
    gradeableCount: lesson.gradeableCount + 1,
    updatedAt: iso,
  }));
}

export async function creditLessons(
  root: string,
  ids: readonly string[],
  verdict: LessonVerdict,
  now = new Date(),
): Promise<void> {
  const iso = now.toISOString();
  await mutateWritableTiers(root, ids, (lesson) => creditLesson(lesson, verdict, iso));
}

export async function gardenProjectLessons(
  root: string,
  mutate: (current: HarnessLesson[]) => HarnessLesson[],
): Promise<HarnessLesson[]> {
  return mutateStore(lessonsStorePath(root), "project", mutate);
}

export async function gardenGlobalLessons(
  mutate: (current: HarnessLesson[]) => HarnessLesson[],
): Promise<HarnessLesson[]> {
  if (!existsSync(globalLessonsStorePath())) {
    return [];
  }
  return mutateStore(globalLessonsStorePath(), "global", mutate);
}
