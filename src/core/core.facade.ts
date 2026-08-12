import {
  appendAttestation,
  attestationPath,
  fingerprintOf,
  readAttestations,
  verifyChain,
} from "./attest/attest.service.ts";
import {
  formatAvailableInventory,
  formatCapabilityDigest,
  formatDoctorWarn,
  isAvailableNotEnabled,
  listAvailableNotEnabled,
  listNewlyAnnounceable,
} from "./capability/capability.service.ts";
import {
  loadCatalog,
  readProjectPolicyRaw,
  readRuntimeSeen,
  writeRuntimeSeen,
} from "./capability/capability.store.ts";
import { ENABLE_HINT } from "./capability/capability.types.ts";
import {
  commentViolationMessage,
  declaresReason,
  findAddedComments,
  isCommentLine,
  scanAddedComments,
} from "./comment-policy/comment-policy.service.ts";
import { KNOWN_EXTENSION_COUNT, unknownExtensions } from "./comment-policy/comment-syntax.store.ts";
import { evaluateFloor } from "./floor/floor.service.ts";
import { computeGateFingerprint, readLastGate, writeLastGate } from "./gate/gate.artifact.ts";
import {
  appendFilesVerdict,
  isCommandResolutionFailure,
  isRecipeRunner,
  shouldAppendFiles,
} from "./gate/gate.command.ts";
import { filesFromOutput } from "./gate/gate.findings.ts";
import { cachedVerdict, computeInputsHash, isCacheHit } from "./gate/gate.inputs.ts";
import { describeHolder, withGateLock } from "./gate/gate.lock.ts";
import { gapsFromArtifact } from "./gate/gate.service.ts";
import { patchHandoff, readForeignSlices, readHandoff, readHandoffFile } from "./handoff/handoff.service.ts";
import { authoredLessonId, buildAuthoredLesson } from "./lesson/lesson.authored.ts";
import type { LessonVerdict } from "./lesson/lesson.credit.ts";
import { effectivenessLine, helpRate, lessonEffectiveness } from "./lesson/lesson.credit.ts";
import { gardenAndPersistLessons, promotionCount, renderLessonsMarkdown } from "./lesson/lesson.garden.ts";
import { formatLessonLink, isStaleLesson, lessonLinkVerdict, parseLessonLink } from "./lesson/lesson.link.ts";
import {
  appliesHere,
  isInjectable,
  renderLessonBlock,
  selectLessons as selectLessonsInner,
} from "./lesson/lesson.select.ts";
import { recordLessonFromFailure } from "./lesson/lesson.service.ts";
import {
  allLessons,
  creditLessons as creditLessonsInner,
  globalLessonsStorePath,
  markGradeable,
  readGlobalLessons,
  readProjectLessons,
  touchAccessed as touchAccessedInner,
  upsertLesson as upsertLessonInner,
  upsertProjectLesson as upsertProjectLessonInner,
  writeProjectLessons as writeProjectLessonsInner,
} from "./lesson/lesson.store.ts";
import { durableViewVerdict, resolveSyncMode } from "./lesson/lesson.sync.ts";
import type { HarnessLesson, LessonTier } from "./lesson/lesson.types.ts";
import { validityReason } from "./lesson/lesson.validity.ts";
import {
  groupByProvider,
  railsNeverFired,
  sessionReportMarkdown,
} from "./observability/observability.report.ts";
import {
  DEFAULT_OBS,
  recordAudit,
  recordFromEvent,
  recordObs,
} from "./observability/observability.service.ts";
import { getRollup, pruneObs, pruneSpool, readSignalEvents } from "./observability/observability.store.ts";
import { decisionsFrom, NOTHING_WAS_THE_HARNESS, whyText } from "./observability/observability.why.ts";
import {
  isObservableRail,
  OBSERVABLE_RAILS,
  observeAttrs,
  shouldObserve,
  unobservableRails,
} from "./observe/observe.service.ts";
import { detectDeviations, detectPlan } from "./plan/plan.detect.ts";
import { evaluatePlanGate, planVerdict } from "./plan/plan.service.ts";
import { guardPolicySurface } from "./policy/policy.guard.ts";
import {
  acceptPolicySources,
  allDivergedPaths,
  checkPolicyBaseline,
  divergedPaths,
  policySourceFingerprint,
  recordPolicyBaseline,
  refreshPolicyBaselines,
} from "./policy/policy.integrity.ts";
import {
  isUnderCodePaths,
  loadPolicy,
  resolveProjectPosture,
  resolveProjectSyncMode,
} from "./policy/policy.loader.ts";
import { operatorBootstrapLines } from "./policy/policy.operator.ts";
import { isOperatorMode, OPERATOR_MODES } from "./policy/policy.posture.ts";
import { activeRails } from "./policy/policy.rails.ts";
import { forProvider } from "./policy/policy.types.ts";
import { checkCollision, heartbeat, register, release, sweepStale } from "./presence/presence.service.ts";
import {
  allDecisionFiles,
  formatDecisionDigest,
  needsAction,
  readDecision,
  readDecisions,
} from "./release/release.decisions.ts";
import { readReleaseSeen, writeReleaseSeen } from "./release/release.seen.ts";
import { evaluateShellCommand } from "./shell-policy/shell-policy.service.ts";
import { clearShellStall } from "./shell-policy/shell-policy.stall.ts";
import { appendShipLedger, hasRecentEvidence, newestChangeMs, readShipLedger } from "./ship/ship.ledger.ts";
import {
  detectShipClaim,
  evaluateEmptyDiffAntiShip,
  evaluateShipEvidenceGate,
  recentShipClaimActive,
  touchesRuntime,
} from "./ship/ship.service.ts";
import {
  recordResolution,
  resolutionFor,
  resolutionHistoryLine,
} from "./stagnation/stagnation.resolution.ts";
import { computeFingerprint } from "./stagnation/stagnation.service.ts";
import { clearFingerprint, fingerprintHits, trackFingerprint } from "./stagnation/stagnation.store.ts";
import {
  readParentModelState,
  upsertParentModelState,
} from "./subagent-policy/subagent-policy.parent-model.ts";
import { evaluateSubagentSpawn } from "./subagent-policy/subagent-policy.service.ts";
import { endedWithoutActing, idleTurnMessage, readTurnActivity } from "./turn/turn.activity.ts";
import { formatAutopilotBlock, resolveAutopilot } from "./turn/turn.autopilot.ts";
import {
  buildGaps,
  classifyGateFailure,
  formatCarriedGaps,
  formatGapFeedback,
  formatProgressiveContext,
  mergeGaps,
  suggestionFor,
} from "./turn/turn.failure-signals.ts";
import {
  checkLoopCap,
  currentLoopCount,
  effectiveLoopCount,
  markBooted,
  nextLoop,
  resetLoop,
} from "./turn/turn.loop-counter.ts";
import { evaluateUntrustedContent } from "./untrusted/untrusted.service.ts";
import { clearFramingMarker } from "./untrusted/untrusted.store.ts";

async function selectLessons(
  args: Parameters<typeof selectLessonsInner>[0],
): Promise<{ lessons: HarnessLesson[]; usedIds: string[]; omitted: number }> {
  return await selectLessonsInner(args);
}

async function touchAccessed(root: string, ids: string[], now?: Date): Promise<void> {
  await touchAccessedInner(root, ids, now);
}

async function upsertProjectLesson(root: string, lesson: HarnessLesson): Promise<HarnessLesson> {
  return await upsertProjectLessonInner(root, lesson);
}

async function writeProjectLessons(root: string, lessons: HarnessLesson[]): Promise<void> {
  await writeProjectLessonsInner(root, lessons);
}

async function upsertLesson(
  root: string,
  lesson: HarnessLesson,
  tier: Exclude<LessonTier, "core">,
): Promise<HarnessLesson> {
  return await upsertLessonInner(root, lesson, tier);
}

async function creditLessons(
  root: string,
  ids: readonly string[],
  verdict: LessonVerdict,
  now?: Date,
): Promise<void> {
  await creditLessonsInner(root, ids, verdict, now);
}

export const coreFacade = {
  capability: {
    ENABLE_HINT,
    loadCatalog,
    readProjectPolicyRaw,
    readRuntimeSeen,
    writeRuntimeSeen,
    isAvailableNotEnabled,
    listAvailableNotEnabled,
    listNewlyAnnounceable,
    formatCapabilityDigest,
    formatDoctorWarn,
    formatAvailableInventory,
  },
  gate: {
    writeLastGate,
    readLastGate,
    computeGateFingerprint,
    computeInputsHash,
    isCacheHit,
    cachedVerdict,
    gapsFromArtifact,
    withGateLock,
    describeHolder,
    shouldAppendFiles,
    appendFilesVerdict,
    isRecipeRunner,
    isCommandResolutionFailure,
    filesFromOutput,
  },
  stagnation: {
    computeFingerprint,
    trackFingerprint,
    fingerprintHits,
    clearFingerprint,
    recordResolution,
    resolutionFor,
    resolutionHistoryLine,
  },
  handoff: {
    patchHandoff,
    readHandoff,
    readHandoffFile,
    readForeignSlices,
  },
  lesson: {
    recordLessonFromFailure,
    buildAuthoredLesson,
    authoredLessonId,
    selectLessons,
    touchAccessed,
    upsertProjectLesson,
    upsertLesson,
    writeProjectLessons,
    readProjectLessons,
    readGlobalLessons,
    // why: the three tiers, deduped. The durable view renders from this rather than from the project store, or two
    // of the three tiers never reach the host that depends on that file.
    allLessons,
    globalLessonsStorePath,
    creditLessons,
    markGradeable,
    gardenAndPersistLessons,
    renderLessonsMarkdown,
    durableViewVerdict,
    resolveSyncMode,
    // why: one renderer. `src/entrypoints/support.ts` carried a copy because this was not exposed, so the tier
    // added to the core block never reached the text the model actually receives
    // ([/decisions/ad-040.md](/decisions/ad-040.md)).
    renderLessonBlock,
    promotionCount,
    isInjectable,
    appliesHere,
    isStaleLesson,
    lessonLinkVerdict,
    parseLessonLink,
    formatLessonLink,
    validityReason,
    lessonEffectiveness,
    effectivenessLine,
    helpRate,
  },
  observability: {
    DEFAULT_OBS,
    recordObs,
    recordFromEvent,
    recordAudit,
    groupByProvider,
    sessionReportMarkdown,
    railsNeverFired,
    readSignalEvents,
    getRollup,
    decisionsFrom,
    whyText,
    NOTHING_WAS_THE_HARNESS,
    pruneObs,
    pruneSpool,
  },
  untrusted: {
    evaluateUntrustedContent,
    clearFramingMarker,
  },
  plan: {
    detectPlan,
    detectDeviations,
    evaluatePlanGate,
    planVerdict,
  },
  policy: {
    guardPolicySurface,
    checkPolicyBaseline,
    policySourceFingerprint,
    recordPolicyBaseline,
    refreshPolicyBaselines,
    acceptPolicySources,
    divergedPaths,
    allDivergedPaths,
    activeRails,
    operatorBootstrapLines,
    loadPolicy,
    resolveProjectPosture,
    resolveProjectSyncMode,
    OPERATOR_MODES,
    isOperatorMode,
    isUnderCodePaths,
    forProvider,
  },
  shellPolicy: {
    evaluateShellCommand,
    clearShellStall,
  },
  subagentPolicy: {
    evaluateSubagentSpawn,
    upsertParentModelState,
    readParentModelState,
  },
  commentPolicy: {
    scanAddedComments,
    findAddedComments,
    isCommentLine,
    declaresReason,
    commentViolationMessage,
    unknownExtensions,
    KNOWN_EXTENSION_COUNT,
  },
  ship: {
    detectShipClaim,
    touchesRuntime,
    recentShipClaimActive,
    evaluateEmptyDiffAntiShip,
    evaluateShipEvidenceGate,
    appendShipLedger,
    readShipLedger,
    hasRecentEvidence,
    newestChangeMs,
  },
  presence: {
    register,
    heartbeat,
    checkCollision,
    sweepStale,
    release,
  },
  floor: {
    evaluateFloor,
  },
  observe: {
    shouldObserve,
    observeAttrs,
    OBSERVABLE_RAILS,
    isObservableRail,
    unobservableRails,
  },
  release: {
    readDecision,
    readDecisions,
    allDecisionFiles,
    needsAction,
    formatDecisionDigest,
    readReleaseSeen,
    writeReleaseSeen,
  },
  attest: {
    appendAttestation,
    readAttestations,
    verifyChain,
    attestationPath,
    fingerprintOf,
  },
  turn: {
    readTurnActivity,
    endedWithoutActing,
    idleTurnMessage,
    currentLoopCount,
    nextLoop,
    resetLoop,
    checkLoopCap,
    effectiveLoopCount,
    markBooted,
    resolveAutopilot,
    formatAutopilotBlock,
    classifyGateFailure,
    suggestionFor,
    buildGaps,
    formatCarriedGaps,
    formatGapFeedback,
    mergeGaps,
    formatProgressiveContext,
  },
};

export type CoreFacade = typeof coreFacade;
