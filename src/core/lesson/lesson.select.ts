import type { LessonsPolicyConfig } from "../policy/policy.types.ts";
import { isStaleLesson, lessonLinkVerdict } from "./lesson.link.ts";
import { rankScore } from "./lesson.score.ts";
import { allLessons, touchAccessed } from "./lesson.store.ts";
import type { HarnessLesson } from "./lesson.types.ts";
import { isWithinValidity } from "./lesson.validity.ts";

export type SelectMode = "session" | "retry";

const OMIT_NOTE_RESERVE = 96;

// invariant: injectable is decided before ranking, not by scoring a withheld lesson low. A stale or out-of-window
// lesson must not reach the turn at any score.
export function isInjectable(lesson: HarnessLesson, now: Date): boolean {
  return !isStaleLesson(lesson) && isWithinValidity(lesson, now);
}

/**
 * why: a global lesson is read from many repositories, so one stored `staleReason` cannot be true for all of
 * them — a ref that is missing here may be present in the product the lesson came from. Applicability is
 * therefore computed per repository for the global tier, while a project lesson relies on the flag `garden`
 * wrote against the same repository it lives in.
 */
export function appliesHere(root: string, lesson: HarnessLesson): boolean {
  if (lesson.tier !== "global" || lesson.refs.length === 0) {
    return true;
  }
  return !lessonLinkVerdict(root, lesson.refs).stale;
}

function allowedForMode(lesson: HarnessLesson, mode: SelectMode, gate?: string): boolean {
  if (lesson.status === "quarantine") {
    return false;
  }
  if (mode === "session") {
    return lesson.status === "active";
  }
  if (lesson.status === "active") {
    return !gate || lesson.failedGate === gate || lesson.failedGate === "stagnation";
  }
  if (lesson.status === "candidate") {
    return Boolean(gate) && lesson.failedGate === gate;
  }
  return false;
}

// why: the tier is rendered because it calibrates trust — a lesson carried in from another product is advice
// about a different repository, and the turn should be able to tell.
export function renderLessonBlock(lesson: HarnessLesson): string {
  const lines = [
    `- [${lesson.failedGate}/${lesson.status}/${lesson.tier}] ${lesson.instruction}`,
    `  avoid: ${lesson.avoid}`,
    `  prefer: ${lesson.prefer}`,
    `  before retrying: ${lesson.preRetryCheck}`,
  ];
  return lines.join("\n");
}

export function formatLessonsSection(lessons: HarnessLesson[], title: string): string {
  if (lessons.length === 0) {
    return "";
  }
  return [title, ...lessons.map((lesson) => renderLessonBlock(lesson))].join("\n");
}

export function omitLessonsNote(omitted: number): string {
  if (omitted <= 0) {
    return "";
  }
  const noun = omitted === 1 ? "lesson" : "lessons";
  return `_(${omitted} more active ${noun} omitted under char budget)_`;
}

export function packLessonsUnderBudget(args: { lessons: HarnessLesson[]; maxChars: number; title: string }): {
  body: string;
  included: HarnessLesson[];
  omitted: number;
} {
  const { lessons, title } = args;
  const maxChars = Math.max(0, args.maxChars);
  if (lessons.length === 0) {
    return { body: "", included: [], omitted: 0 };
  }

  const packBudget = Math.max(0, maxChars - OMIT_NOTE_RESERVE);
  const included: HarnessLesson[] = [];

  for (const lesson of lessons) {
    const candidate = formatLessonsSection([...included, lesson], title);
    if (included.length === 0) {
      included.push(lesson);
      if (candidate.length > packBudget) {
        break;
      }
      continue;
    }
    if (candidate.length <= packBudget) {
      included.push(lesson);
      continue;
    }
    break;
  }

  let omitted = lessons.length - included.length;
  let body = formatLessonsSection(included, title);
  const note = omitLessonsNote(omitted);
  if (!note) {
    return { body, included, omitted };
  }

  const withNote = `${body}\n${note}`;
  if (withNote.length <= maxChars) {
    return { body: withNote, included, omitted };
  }

  while (included.length > 1) {
    included.pop();
    omitted = lessons.length - included.length;
    body = formatLessonsSection(included, title);
    const next = `${body}\n${omitLessonsNote(omitted)}`;
    if (next.length <= maxChars) {
      return { body: next, included: [...included], omitted };
    }
  }

  return { body, included: [...included], omitted: lessons.length - included.length };
}

export function rankLessonsForSync(lessons: HarnessLesson[]): HarnessLesson[] {
  return [...lessons]
    .filter((lesson) => lesson.status === "active")
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        b.hitCount - a.hitCount ||
        b.confidence - a.confidence ||
        new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime() ||
        a.id.localeCompare(b.id),
    );
}

export type LessonSelectionArgs = {
  projectDir: string;
  config: LessonsPolicyConfig;
  mode: SelectMode;
  gate?: string;
  text?: string;
  now?: Date;
};

export type LessonSelection = { lessons: HarnessLesson[]; usedIds: string[]; omitted: number };

/**
 * The selection with no side effect, so a reader can ask what would be injected without becoming an injection.
 *
 * why this is separate: `selectLessons` marks the picked lessons as accessed, which is correct at an injection and
 * wrong anywhere else. `doctor` needs the same answer and must not move the accessed timestamps — a measurement
 * that changes what it measures is not a measurement ([/decisions/ad-027.md](/decisions/ad-027.md)).
 *
 * invariant: one selector. Re-deriving the budget arithmetic for the reporting path would be a second answer that
 * drifts from the first ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
export function previewLessonSelection(args: LessonSelectionArgs): LessonSelection {
  if (!args.config.enabled) {
    return { lessons: [], usedIds: [], omitted: 0 };
  }

  const maxCount = args.mode === "session" ? args.config.maxInjectSession : args.config.maxInjectRetry;
  const maxChars = args.mode === "session" ? args.config.maxCharsSession : args.config.maxCharsRetry;
  const now = args.now ?? new Date();

  const ranked = allLessons(args.projectDir)
    .filter(
      (lesson) =>
        isInjectable(lesson, now) &&
        appliesHere(args.projectDir, lesson) &&
        allowedForMode(lesson, args.mode, args.gate),
    )
    .map((lesson) => ({
      lesson,
      score: rankScore(lesson, {
        gate: args.gate,
        text: args.text,
        decayLambda: args.config.decayLambda,
        projectBoost: args.config.projectBoost,
        now,
      }),
    }))
    .sort((a, b) => b.score - a.score || b.lesson.priority - a.lesson.priority);

  // invariant: pinned first, in the operator's own order, before anything scored. Everything else about a pinned
  // lesson still applies — staleness, validity, mode and the char budget all bind
  // ([/decisions/ad-043.md](/decisions/ad-043.md)).
  const ordered = [
    ...ranked.filter((row) => row.lesson.pinned),
    ...ranked.filter((row) => !row.lesson.pinned),
  ];

  const picked: HarnessLesson[] = [];
  let chars = 0;
  for (const row of ordered) {
    if (picked.length >= maxCount) {
      break;
    }
    const block = renderLessonBlock(row.lesson);
    if (chars + block.length > maxChars && picked.length > 0) {
      break;
    }
    if (block.length > maxChars && picked.length === 0) {
      picked.push(row.lesson);
      break;
    }
    picked.push(row.lesson);
    chars += block.length;
  }

  // hazard: `maxInjectSession` defaults to 5 and `maxCharsSession` to 900, which fits about two rendered blocks —
  // so the count promises five and delivers two. Whoever reads the injected block has to be able to tell that
  // eligible lessons were dropped, and so does the operator ([/decisions/ad-043.md](/decisions/ad-043.md)).
  return {
    lessons: picked,
    usedIds: picked.map((lesson) => lesson.id),
    omitted: ordered.length - picked.length,
  };
}

export async function selectLessons(args: LessonSelectionArgs): Promise<LessonSelection> {
  const selection = previewLessonSelection(args);
  const accessed = selection.lessons.filter((lesson) => lesson.source !== "core").map((lesson) => lesson.id);
  await touchAccessed(args.projectDir, accessed, args.now ?? new Date());
  return selection;
}
