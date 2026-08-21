import { MIN_RUN } from "../duplication/duplication.service.ts";
import { DEFAULT_OBS } from "../observability/observability.types.ts";
import type { Policy } from "./policy.types.ts";

export const DEFAULT_LESSONS_POLICY: Policy["intelligence"]["lessons"] = {
  enabled: false,
  maxInjectSession: 5,
  maxInjectRetry: 8,
  maxCharsSession: 900,
  maxCharsRetry: 1400,
  promoteHitCount: 2,
  decayLambda: 0.02,
  projectBoost: 1.5,
  syncRulesFile: "auto",
  gardenOnSessionEnd: true,
};

export const DEFAULTS: Policy = {
  version: 1,
  mode: "solo",
  codePaths: ["src", "apps", "libs", "packages"],
  grind: {
    enabled: false,
    maxLoops: 5,
    lintCommand: null,
    testCommand: null,
    appendFiles: "auto",
  },
  shipGate: {
    enabled: false,
    runtimePathPrefixes: ["src", "apps", "libs", "packages", "deploy", "scripts"],
    runtimePathExcludes: [".tlc/", "**/node_modules/", "**/.git/"],
    evidenceDir: null,
    evidenceMaxAgeHours: 48,
    emptyDiffAntiShip: false,
    claimWindowMinutes: 10,
  },
  subagents: {
    enforceAllowlist: false,
    requireModel: false,
    allowedModels: [],
    blockedPatterns: ["-fast(?:$|[^a-z0-9])", "/fast(?:$|[^a-z0-9])"],
    minEffort: null,
    blockParentFast: false,
    blockMode: "deny",
    readOnlyTypes: ["explore"],
  },
  docs: {
    command: null,
    severity: "warn",
  },
  observe: {
    enabled: false,
    rails: [],
  },
  comments: {
    enabled: false,
    onViolation: "followup",
    mode: "declared",
  },
  supplyChain: {
    enabled: false,
  },
  duplication: {
    enabled: false,
    minRun: MIN_RUN,
  },
  obs: {
    globalSpool: false,
    includePayloads: DEFAULT_OBS.includePayloads,
    maxAttrChars: DEFAULT_OBS.maxAttrChars,
    sessionCostAlertUsd: DEFAULT_OBS.sessionCostAlertUsd,
    retentionDays: DEFAULT_OBS.retentionDays,
  },
  untrustedContent: {
    mode: "frame",
    enabled: false,
    extraTools: [],
    extraCommandPatterns: [],
  },
  planGate: {
    enabled: false,
    windowMinutes: 120,
  },
  rules: {
    enabled: false,
  },
  shell: {
    catastrophicAsk: true,
    stallDetection: false,
    stallRepeatThreshold: 3,
  },
  intelligence: {
    gapFeedback: true,
    failureClassification: true,
    progressiveHandoff: true,
    progressiveContext: true,
    autopilot: true,
    idleTurnGate: false,
    budgetContinue: false,
    budgetContinueAfterLoops: 3,
    lessons: { ...DEFAULT_LESSONS_POLICY },
  },
  mcpPrime: [],
  bootstrapExtra: [],
};
