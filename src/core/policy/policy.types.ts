/**
 * `declared` requires a reason marker, `strict` accepts no added comment at all, and `resolvable` is `declared`
 * plus the question neither can ask: does the comment mean anything to a reader who was not in the session that
 * wrote it ([/decisions/ad-070.md](/decisions/ad-070.md))?
 */
export type CommentMode = "declared" | "strict" | "resolvable";

import type { EffortLevel } from "../../contracts/effort.ts";
import type { AppendFilesMode } from "../gate/gate.types.ts";
import type { LessonsSyncMode } from "../lesson/lesson.sync.ts";

// invariant: one word per posture. A second spelling for any of them is what let `"mode": "focus"` reach
// the loader unvalidated, match no branch, and silently produce a policy with no posture line.
export type OperatorMode = "paired" | "solo" | "focus";

export type ProviderScoped<T> = T[] | Record<string, T[]>;

export function forProvider<T>(scoped: ProviderScoped<T> | undefined, provider: string): T[] | null {
  if (scoped === undefined) {
    return null;
  }
  if (Array.isArray(scoped)) {
    return scoped;
  }
  return scoped[provider] ?? null;
}

export type LessonsPolicyConfig = {
  enabled: boolean;
  maxInjectSession: number;
  maxInjectRetry: number;
  maxCharsSession: number;
  maxCharsRetry: number;
  promoteHitCount: number;
  decayLambda: number;
  projectBoost: number;
  syncRulesFile: LessonsSyncMode;
  gardenOnSessionEnd: boolean;
};

export type Policy = {
  version: 1;
  mode: OperatorMode;
  projectName?: string;
  codePaths: string[];
  grind: {
    enabled: boolean;
    maxLoops: number;
    lintCommand: string[] | null;
    testCommand: string[] | null;
    appendFiles: AppendFilesMode;
  };
  shipGate: {
    enabled: boolean;
    runtimePathPrefixes: string[];
    runtimePathExcludes: string[];
    evidenceDir: string | null;
    evidenceMaxAgeHours: number;
    emptyDiffAntiShip: boolean;
    claimWindowMinutes: number;
  };
  subagents: {
    enforceAllowlist: boolean;
    requireModel: boolean;
    allowedModels: ProviderScoped<string>;
    blockedPatterns: ProviderScoped<string>;
    minEffort: EffortLevel | null;
    blockParentFast: boolean;
    blockMode: "deny" | "ask";
    readOnlyTypes: string[];
  };
  docs: {
    /** Null means the gate does not exist for this project. */
    command: string[] | null;
    severity: "warn" | "deny";
  };
  observe: ObserveConfig;
  comments: {
    enabled: boolean;
    onViolation: "followup" | "off";
    mode: CommentMode;
  };
  supplyChain: {
    enabled: boolean;
  };
  duplication: {
    enabled: boolean;
    /** why: the window is the only knob, because it is the only one calibration moved. Six is where matches stopped being punctuation. */
    minRun: number;
  };
  obs: {
    globalSpool: boolean;
    includePayloads: boolean;
    maxAttrChars: number;
    sessionCostAlertUsd: number | null;
    retentionDays: number;
  };
  untrustedContent: {
    enabled: boolean;
    extraTools: string[];
    extraCommandPatterns: string[];
  };
  planGate: {
    enabled: boolean;
    windowMinutes: number;
  };
  shell: {
    catastrophicAsk: boolean;
    stallDetection: boolean;
    stallRepeatThreshold: number;
  };
  intelligence: {
    gapFeedback: boolean;
    failureClassification: boolean;
    progressiveHandoff: boolean;
    progressiveContext: boolean;
    autopilot: boolean;
    idleTurnGate: boolean;
    budgetContinue: boolean;
    budgetContinueAfterLoops: number;
    lessons: LessonsPolicyConfig;
  };
  mcpPrime: string[];
  bootstrapExtra: string[];
};

export type PartialPolicy = Partial<Policy> & {
  grind?: Partial<Policy["grind"]>;
  shipGate?: Partial<Policy["shipGate"]>;
  subagents?: Partial<Policy["subagents"]>;
  docs?: Partial<Policy["docs"]>;
  comments?: Partial<Policy["comments"]>;
  obs?: Partial<Policy["obs"]>;
  untrustedContent?: Partial<Policy["untrustedContent"]>;
  planGate?: Partial<Policy["planGate"]>;
  shell?: Partial<Policy["shell"]>;
  intelligence?: Partial<Policy["intelligence"]> & {
    lessons?: Partial<LessonsPolicyConfig>;
  };
};

/**
 * why: observation runs a rail's checker while the rail is not enforcing, so the harness can tell "the model
 * already does this" from "the rule works". Opt-in and default empty: it costs a diff scan per turn and answers a
 * question only an operator who is asking it needs answered.
 */
export type ObserveConfig = {
  enabled: boolean;
  /** Rails to observe by name. An unknown name is inert rather than an error — a rail may not exist yet. */
  rails: string[];
};
