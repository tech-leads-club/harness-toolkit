export type LessonStatus = "candidate" | "active" | "quarantine";

/** How the lesson was learned. Provenance, not location — see {@link LessonTier}. */
export type LessonSource = "core" | "project" | "manual";

/**
 * Where the lesson lives, which decides who sees it: `core` ships in the runtime, `global` is this machine and
 * every product on it, `project` is this repository alone.
 *
 * invariant: nothing moves between tiers on its own ([/decisions/ad-040.md](/decisions/ad-040.md)).
 */
export type LessonTier = "core" | "global" | "project";

/** A repository-relative reference to the thing that makes a lesson true. */
export type LessonLink = {
  path: string;
  symbol?: string;
};

export type LessonLinkStatus = "present" | "path-missing" | "symbol-missing" | "unreadable";

/**
 * hazard: `unproven` is not a passing reading — it means the lesson was injected and no gate run has graded it.
 * `not-injected` is the separate, uninteresting case, kept apart so a store of brand-new lessons does not read as
 * a store of unjustified ones ([/decisions/ad-039.md](/decisions/ad-039.md)).
 */
export type LessonEffectiveness = "helped" | "neutral" | "unproven" | "not-injected";

export type HarnessLesson = {
  id: string;
  scope: "gate-execution";
  failedGate: string;
  category: string;
  triggerTokens: string[];
  instruction: string;
  avoid: string;
  prefer: string;
  preRetryCheck: string;
  source: LessonSource;
  // invariant: derived on read from the store the lesson came out of, never trusted from the file.
  tier: LessonTier;
  status: LessonStatus;
  confidence: number;
  hitCount: number;
  priority: number;
  /**
   * A standing rule the operator does not want ranked. Pinned lessons are placed before every scored lesson,
   * still subject to staleness, validity and the char budget.
   *
   * why: ranking is built for lessons the harness inferred from failures. An instruction the operator wrote
   * deliberately competes with those on confidence and priority and loses to a shipped seed, so it is written,
   * stored, correct, and never delivered ([/decisions/ad-043.md](/decisions/ad-043.md)).
   */
  pinned: boolean;
  /** What makes this lesson true. Empty means it is about conduct and cannot go stale. */
  refs: LessonLink[];
  staleReason?: LessonLinkStatus;
  staleCheckedAt?: string;
  validFrom?: string;
  validTo?: string;
  // why: promotion counts these, not `hitCount` — one stuck session repeating a failure is one observation of
  // the world, not several ([/decisions/ad-038.md](/decisions/ad-038.md)).
  sessionKeys: string[];
  /** Times selected for injection, in any mode. */
  injectedCount: number;
  /**
   * Times injected **for a gate**, which is the only injection a later gate run can grade.
   *
   * hazard: `injectedCount` counts session-start injections too, and those are never graded — a lesson whose gate
   * is `any` is not eligible on a retry at all, so judging it by `injectedCount` warned "unproven" forever on a
   * perfectly healthy store ([/decisions/ad-044.md](/decisions/ad-044.md)).
   */
  gradeableCount: number;
  helpedCount: number;
  neutralCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAccessedAt: string;
  updatedAt: string;
};

export type LessonStoreFile = {
  version: 1;
  lessons: HarnessLesson[];
};

/** A gate's injected lessons awaiting a verdict, carried on the handoff between one stop and the next. */
export type PendingLessonCredit = {
  gate: string;
  ids: string[];
  at: string;
  // why: the handoff is per-project, not per-session, so without this a lesson injected for session A's
  // failing gate gets credited by whichever session B next happens to pass the same gate — helped/neutral
  // it never earned. Optional so an on-disk record from before this field existed still credits once,
  // the same legacy fallback AD-038 used for pre-existing lesson records.
  sessionKey?: string;
};
