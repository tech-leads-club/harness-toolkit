import type { FailureCategory, GateGap } from "../gate/gate.types.ts";
import type { PendingLessonCredit } from "../lesson/lesson.types.ts";
import type { PlanDeviation } from "../plan/plan.types.ts";
import type { OperatorMode } from "../policy/policy.types.ts";

export type GateResult = "pass" | "fail" | "skipped";

export type HandoffShared = {
  mode: OperatorMode;
  project_name?: string;
  git_branch?: string;
  git_sha?: string;
  updated_at: string;
};

export type HandoffProviderSlice = {
  updated_at: string;
  session_narrative?: string;
  completed?: string[];
  last_ship_claim_at?: string;
  last_ship_claim_snippet?: string;
  last_ship_claim_kind?: "structured";
  last_changed_files?: string[];
  last_stop_status?: string;
  last_gate_result?: GateResult;
  last_fingerprint?: string;
  fingerprint_hits?: number;
  last_failure_category?: FailureCategory;
  // why: the lessons injected for a gate are graded by that gate's next run, which happens in a later process.
  // The handoff is the only state that survives between the two ([/decisions/ad-039.md](/decisions/ad-039.md)).
  pending_lesson_credit?: PendingLessonCredit;
  previous_gaps?: GateGap[];
  /**
   * why: the revision this turn started at. Every stop-time gate diffs against it rather than against `HEAD`,
   * because a turn that commits moves `HEAD` past its own changes and each gate then reads an empty diff
   * ([/decisions/ad-058.md](/decisions/ad-058.md)).
   */
  turn_base_sha?: string;
  plan_paths?: string[];
  plan_at?: string;
  plan_snippet?: string;
  plan_deviations?: PlanDeviation[];
  next_action?: string;
  blockers?: string;
  machine_state?: Record<string, unknown>;
};

export const HANDOFF_SCHEMA = "harness.handoff.v3" as const;

/** The project-wide facts every session shares — no turn-scoped continuity here (moved to per-session files,
 * [/decisions/ad-122.md](/decisions/ad-122.md)). */
export type HandoffFile = {
  schema: typeof HANDOFF_SCHEMA;
  shared: HandoffShared;
};

export type ForeignSlice = {
  provider: string;
  plan_paths?: string[];
  plan_at?: string;
  plan_snippet?: string;
  plan_deviations?: PlanDeviation[];
  next_action?: string;
  blockers?: string;
};

export function defaultHandoffFile(mode: OperatorMode = "solo"): HandoffFile {
  return {
    schema: HANDOFF_SCHEMA,
    shared: { mode, updated_at: new Date().toISOString() },
  };
}

export function isHandoffFile(value: unknown): value is HandoffFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<HandoffFile>;
  return (
    candidate.schema === HANDOFF_SCHEMA && typeof candidate.shared === "object" && candidate.shared !== null
  );
}

export const HANDOFF_SESSION_SCHEMA = "harness.handoff-session.v1" as const;

/** which session last wrote this continuity file, and when — liveness itself is decided elsewhere, against
 * presence's own heartbeat, not against anything stored here ([/decisions/ad-122.md](/decisions/ad-122.md)). */
type HandoffSessionOwner = {
  session_key: string;
  provider: string;
  updated_at: string;
};

export type HandoffSessionFile = {
  schema: typeof HANDOFF_SESSION_SCHEMA;
  owner: HandoffSessionOwner;
  slice: HandoffProviderSlice;
};

export function isHandoffSessionFile(value: unknown): value is HandoffSessionFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<HandoffSessionFile>;
  if (candidate.schema !== HANDOFF_SESSION_SCHEMA) {
    return false;
  }
  const owner = candidate.owner;
  if (typeof owner !== "object" || owner === null) {
    return false;
  }
  const o = owner as Partial<HandoffSessionOwner>;
  return (
    typeof o.session_key === "string" &&
    typeof o.provider === "string" &&
    typeof o.updated_at === "string" &&
    typeof candidate.slice === "object" &&
    candidate.slice !== null
  );
}
