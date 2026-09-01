import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade, type LastGateArtifact, type PendingLessonCredit, type Policy } from "../core/index.ts";
import {
  filterCodeTargets,
  filterTestTargets,
  listAddedLines,
  listChangedRepoFiles,
  listTrackedFiles,
  runCommand,
} from "../platform/git.ts";
import { flagsDir } from "../platform/paths.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import {
  currentGitSha,
  formatLessonsBlock,
  obsConfigFor,
  sessionIdFromKey,
  shaScopeRoot,
} from "./support.ts";

const STAGNATION_FOLLOWUP = [
  "BLOCKED: identical validation fingerprint repeated — no progress between attempts.",
  "TRIED: same gate failure signature as the previous stop loop.",
  "NEED: change approach. Do not repeat the same fix. Inspect root cause, try a different path, or escalate with BLOCKED/TRIED/NEED.",
].join("\n");

/**
 * A gate is the one proof the harness decides rather than witnesses, so it is recorded where every gate already
 * funnels through — the same argument `recordGateOutcome` makes for itself: a gate added later cannot be
 * forgotten ([/decisions/ad-100.md](/decisions/ad-100.md)).
 *
 * invariant: only a gate that passed. Recording a failure would let "the gate ran" satisfy a rule that asked for
 * "the gate passed", which is the whole point of asking.
 */
async function observeGateForRules(args: {
  root: string;
  shaRoot: string;
  sessionKey: string;
  policy: Policy;
  gate: string;
  passed: boolean;
}): Promise<void> {
  if (!args.passed || !coreFacade.rules.wantsGate(args.root, args.policy.rules)) {
    return;
  }
  coreFacade.rules.observeGate(args.root, args.policy.rules, args.gate, {
    sha: await currentGitSha(args.shaRoot),
    sessionKey: args.sessionKey,
    at: new Date().toISOString(),
  });
}

/**
 * hazard: `gate.outcome` was consumed in two places — the rollup counter and the session report's
 * "Gates pass/fail" line — and emitted by nothing. Both read structurally zero, so the report printed a
 * truthful-looking `0 / 0` for every gate this harness has ever run
 * ([/decisions/ad-027.md](/decisions/ad-027.md)).
 *
 * why: recorded here rather than at each call site, so a gate added later cannot be forgotten. Every gate goes
 * through this function; a gate that does not is not run under the lock either.
 */
function recordGateOutcome(args: {
  root: string;
  provider: string;
  sessionKey: string;
  policy: Policy;
  artifact: LastGateArtifact;
  reused: boolean;
}): void {
  coreFacade.observability.recordObs(args.root, obsConfigFor(args.policy), {
    provider: args.provider,
    kind: "gate.outcome",
    sessionKey: args.sessionKey,
    attrs: {
      gate: args.artifact.gate,
      passed: args.artifact.passed,
      exit_code: args.artifact.exitCode,
      duration_ms: args.artifact.durationMs,
      file_count: args.artifact.files.length,
      // why: so `obs report` and `attest` can answer "what environment did this gate run under" after the fact,
      // without the follow-up having had to say it.
      scoped_env: (args.artifact.scopedEnv ?? []).join(",") || "none",
      // why: a reused verdict costs no time, so counting it as a run would make the total gate time read lower
      // than it is and hide the saving instead of showing it ([/decisions/ad-045.md](/decisions/ad-045.md)).
      reused: args.reused,
    },
  });
}

/**
 * why: a gate that deferred has to be findable afterwards. Without a record the only trace was one turn's reply,
 * which is why the same neighbour collision was reported three times as if each were new
 * ([/decisions/ad-073.md](/decisions/ad-073.md)).
 */
function recordGateDeferred(args: {
  root: string;
  provider: string;
  sessionKey: string;
  gate: string;
  holder: string;
  policy: Policy;
}): void {
  coreFacade.observability.recordObs(args.root, obsConfigFor(args.policy), {
    provider: args.provider,
    kind: "gate.outcome",
    sessionKey: args.sessionKey,
    attrs: {
      gate: args.gate,
      // invariant: not `passed: false`. A deferred gate produced no verdict, and recording one as a failure would
      // put a failure in the report that nothing failed.
      deferred_to: args.holder,
      rule: "grind",
    },
  });
}

/**
 * The verdict a gate would produce, without producing it twice.
 *
 * why: keyed on a content hash of the command and the files, which is the monorepo-tooling rule — same inputs,
 * replay the result. A read-only turn in a repository with uncommitted work re-ran the whole suite on every
 * question, because the trigger read the state of the tree rather than what the turn did
 * ([/decisions/ad-045.md](/decisions/ad-045.md)).
 */
/**
 * invariant: a union, so a deferred gate cannot be read as a passing artifact. A shape with an optional artifact
 * would have let `undefined` mean "fine" at three call sites that reach straight for `artifact.passed`
 * ([/decisions/ad-073.md](/decisions/ad-073.md)).
 */
export type GateRun =
  | { kind: "ran"; artifact: LastGateArtifact; reused: boolean }
  | { kind: "deferred"; holder: string };

/**
 * hazard: `GATE_LOCK_WAIT_MS` is 120 000 and the Stop hook is registered with `timeoutSeconds: 120`, so waiting
 * the library default leaves nothing for the gate the wait exists to run — the host kills the hook first. This is
 * the share of the budget a neighbour may spend before the turn stops waiting for it.
 */
export const STOP_LOCK_WAIT_MS = 10_000;

/**
 * why: a test that proves the wait has to wait, and a suite that pays ten seconds for it pays that on every gate
 * run in every environment. This is the only seam and it is read here, so the production default is a constant
 * nobody can reconfigure from a project ([/decisions/ad-073.md](/decisions/ad-073.md)).
 */
export function stopLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const declared = Number(env.TLC_TEST_GATE_LOCK_WAIT_MS);
  return Number.isFinite(declared) && declared > 0 ? declared : STOP_LOCK_WAIT_MS;
}

/**
 * Grades the lessons that were injected the last time this gate failed. `helped` means the gate the lessons were
 * chosen for then passed; `neutral` means it failed again.
 *
 * invariant: consumed exactly once. The pending credit is cleared whether or not any lesson matched, so a single
 * injection cannot be graded twice by two later runs of the same gate.
 *
 * hazard: the gate name is compared, and the session that earned the credit is compared — without either,
 * lessons injected for `lint` would be credited by whichever gate ran next, or by whichever session next
 * happened to run this gate on the same per-project handoff `blockers` lives on, crediting help a session
 * that never saw the lesson did not give ([/decisions/ad-107.md](/decisions/ad-107.md) is the same family).
 */
async function creditPendingLessons(args: {
  root: string;
  provider: string;
  pending: PendingLessonCredit | undefined;
  gate: string;
  sessionKey: string;
  passed: boolean;
}): Promise<void> {
  const { pending } = args;
  if (!pending || pending.gate !== args.gate || pending.ids.length === 0) {
    return;
  }
  if (pending.sessionKey !== undefined && pending.sessionKey !== args.sessionKey) {
    return;
  }
  await coreFacade.lesson.creditLessons(args.root, pending.ids, args.passed ? "helped" : "neutral");
  await coreFacade.handoff.patchHandoff(args.root, args.provider, args.sessionKey, {
    slice: { pending_lesson_credit: undefined },
  });
}

/**
 * why exported: this is the one place a `commit`/`push`/`pr-open` ship-time gate
 * ([/decisions/ad-116.md](/decisions/ad-116.md)) can ask the identical question `stop` asks — same lock, same
 * content-hash cache, same observability. A second implementation is the drift AD-071 already named once.
 */
export async function runLockedGate(args: {
  root: string;
  shaRoot: string;
  provider: string;
  session: string;
  gate: "lint" | "test" | "docs";
  command: string[];
  argvFiles: string[];
  recordFiles: string[];
  sessionKey: string;
  policy: Policy;
  pendingCredit: PendingLessonCredit | undefined;
}): Promise<GateRun> {
  const command = [...args.command, ...args.argvFiles];
  const inputs = coreFacade.gate.computeInputsHash(args.root, args.recordFiles, command);
  const cached = coreFacade.gate.cachedVerdict(coreFacade.gate.readLastGate(args.root), args.gate, inputs);

  let artifact: LastGateArtifact;
  if (cached !== null) {
    artifact = cached;
  } else {
    try {
      artifact = await coreFacade.gate.withGateLock(
        args.root,
        args.provider,
        args.session,
        async () => {
          const result = await runCommand(args.root, args.command, args.argvFiles);
          return coreFacade.gate.writeLastGate({
            root: args.root,
            gate: args.gate,
            exitCode: result.exitCode,
            command,
            files: args.recordFiles,
            durationMs: result.durationMs,
            output: result.output,
            ...(inputs.complete ? { inputsHash: inputs.hash } : {}),
          });
        },
        { waitMs: stopLockWaitMs() },
      );
    } catch (error) {
      // why: a neighbour in the same checkout is running these very commands over this very tree, so the property
      // is being verified — by somebody else. Blocking this turn tells the one participant that cannot act.
      if (!(error instanceof coreFacade.gate.GateLockTimeoutError)) {
        throw error;
      }
      const holder = coreFacade.gate.describeHolder(args.root) ?? "another session";
      recordGateDeferred({ ...args, holder });
      return { kind: "deferred", holder };
    }
  }

  // invariant: recorded outside the lock. A measurement must not widen the window in which one gate blocks another.
  recordGateOutcome({ ...args, artifact, reused: cached !== null });
  await observeGateForRules({ ...args, gate: args.gate, passed: artifact.passed });
  await creditPendingLessons({
    root: args.root,
    provider: args.provider,
    pending: args.pendingCredit,
    gate: args.gate,
    sessionKey: args.sessionKey,
    passed: artifact.passed,
  });
  return { kind: "ran", artifact, reused: cached !== null };
}

async function failGate(args: {
  root: string;
  provider: string;
  sessionKey: string;
  gate: string;
  artifact: LastGateArtifact;
  loopCount: number;
  maxLoops: number;
  policy: Policy;
}): Promise<Decision> {
  const { policy } = args;
  const intel = policy.intelligence;
  const fingerprint = coreFacade.stagnation.computeFingerprint({
    files: args.artifact.files,
    gate: args.gate,
    exitCode: args.artifact.exitCode,
    output: args.artifact.outputTail,
  });
  const hits = coreFacade.stagnation.trackFingerprint(args.root, args.sessionKey, fingerprint);
  const category = coreFacade.gate.isCommandResolutionFailure({
    exitCode: args.artifact.exitCode,
    output: args.artifact.outputTail,
  })
    ? "config"
    : coreFacade.turn.classifyGateFailure(args.gate);
  const freshGaps = coreFacade.gate.gapsFromArtifact({ artifact: args.artifact, category });
  const handoff = coreFacade.handoff.readHandoff(args.root, args.provider, args.sessionKey);
  const gaps = intel.progressiveContext
    ? coreFacade.turn.mergeGaps(handoff.previous_gaps, freshGaps)
    : freshGaps;
  const suggestion = coreFacade.turn.suggestionFor(category, args.gate);
  const effectiveCategory = hits >= 2 ? "stagnation" : category;
  const plan = intel.autopilot
    ? coreFacade.turn.resolveAutopilot({
        category: effectiveCategory,
        gate: hits >= 2 ? "stagnation" : args.gate,
        mode: policy.mode,
        loopCount: args.loopCount,
        maxLoops: args.maxLoops,
        failingFiles: coreFacade.gate.filesFromOutput(args.artifact.outputTail, args.root),
        changedFiles: args.artifact.files,
      })
    : null;

  await coreFacade.handoff.patchHandoff(args.root, args.provider, args.sessionKey, {
    slice: {
      last_gate_result: "fail",
      last_fingerprint: fingerprint,
      fingerprint_hits: hits,
      last_failure_category: intel.failureClassification ? effectiveCategory : undefined,
      previous_gaps: intel.gapFeedback ? gaps : undefined,
      blockers: `${args.gate} gate failed (${effectiveCategory}).`,
      next_action: plan?.next_action ?? suggestion,
    },
  });

  if (hits >= 2 && intel.lessons.enabled) {
    await coreFacade.lesson.recordLessonFromFailure({
      projectDir: args.root,
      gate: args.gate,
      category,
      fingerprint,
      output: args.artifact.outputTail,
      sessionKey: args.sessionKey,
    });
  }

  // why: the same failure identity, resolved before. Offered as a record of what happened rather than a list to
  // edit — a previous resolution is evidence, and AD-024 established that a plan names files from evidence and
  // never from proximity. Absent history changes nothing.
  const resolution = coreFacade.stagnation.resolutionFor(args.root, fingerprint);
  const historyLine = resolution ? coreFacade.stagnation.resolutionHistoryLine(resolution) : "";

  const selected = intel.lessons.enabled
    ? await coreFacade.lesson.selectLessons({
        projectDir: args.root,
        config: intel.lessons,
        mode: "retry",
        gate: args.gate,
        text: hits >= 2 ? `stagnation ${args.artifact.outputTail}` : args.artifact.outputTail,
      })
    : { lessons: [], usedIds: [], omitted: 0 };
  const lessonsBlock = formatLessonsBlock(
    selected.lessons,
    "Lessons for this gate (ranked — apply before inventing a new plan):",
    selected.omitted,
  );

  // why: written after the lessons are chosen and before the turn resumes, so the next run of this same gate is
  // the thing that grades them ([/decisions/ad-039.md](/decisions/ad-039.md)).
  if (selected.usedIds.length > 0) {
    await coreFacade.lesson.markGradeable(args.root, selected.usedIds);
    await coreFacade.handoff.patchHandoff(args.root, args.provider, args.sessionKey, {
      slice: {
        pending_lesson_credit: {
          gate: args.gate,
          ids: selected.usedIds,
          at: new Date().toISOString(),
          sessionKey: args.sessionKey,
        },
      },
    });
  }

  if (hits >= 2) {
    const stagnationGaps = intel.gapFeedback
      ? [
          ...gaps,
          {
            id: "stagnation-0",
            gate: "stagnation",
            category: "stagnation" as const,
            summary: STAGNATION_FOLLOWUP,
          },
        ]
      : [];
    const body = [STAGNATION_FOLLOWUP];
    if (intel.gapFeedback) {
      body.push(
        "",
        coreFacade.turn.formatGapFeedback(
          stagnationGaps,
          coreFacade.turn.suggestionFor("stagnation", "stagnation"),
        ),
      );
    }
    if (historyLine) {
      body.push("", historyLine);
    }
    if (lessonsBlock) {
      body.push("", lessonsBlock);
    }
    if (plan) {
      body.push("", coreFacade.turn.formatAutopilotBlock(plan));
    }
    return { kind: "continue", text: body.join("\n") };
  }

  const parts = [
    `BLOCKED: ${args.gate} failed (loop ${args.loopCount}/${args.maxLoops}).`,
    `TRIED: ${args.gate} on changed files.`,
    `NEED: ${plan?.next_action ?? suggestion}`,
  ];
  if (intel.progressiveContext) {
    parts.push(
      "",
      coreFacade.turn.formatProgressiveContext({
        loopCount: args.loopCount,
        maxLoops: args.maxLoops,
        gate: args.gate,
        category,
        gaps,
        gateOutput: args.artifact.outputTail,
        suggestion: plan?.next_action ?? suggestion,
        // why: the environment the gate actually ran under, and the command that settles it outside the hook.
        // Named from the second attempt only ([/decisions/ad-060.md](/decisions/ad-060.md)).
        scopedEnv: args.artifact.scopedEnv ?? [],
        command: args.artifact.command,
      }),
    );
  } else {
    parts.push("", args.artifact.outputTail);
    if (intel.gapFeedback && gaps.length > 0) {
      parts.push("", coreFacade.turn.formatGapFeedback(gaps, suggestion));
    }
  }
  if (historyLine) {
    parts.push("", historyLine);
  }
  if (lessonsBlock) {
    parts.push("", lessonsBlock);
  }
  if (plan) {
    parts.push("", coreFacade.turn.formatAutopilotBlock(plan));
  }
  return { kind: "continue", text: parts.join("\n") };
}

/**
 * why the sha is fetched twice-or-never: `git rev-parse` is a process spawn and this runs on every stop. The first
 * pass answers whether any `on: stop` rule fired at all, which costs two directory reads; only then is a sha worth
 * a process, and the second pass is the one whose verdict counts. Same shape as the action-time rail
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
async function decideStopRules(
  root: string,
  shaRoot: string,
  policy: Policy,
  sessionKey: string,
): Promise<ReturnType<typeof coreFacade.rules.decideStop>> {
  const context = { sessionKey, mode: policy.mode, shaRoot };
  const dryRun = coreFacade.rules.decideStop(root, policy.rules, { ...context, sha: null });
  if (dryRun.outcomes.length === 0) {
    return dryRun;
  }
  return coreFacade.rules.decideStop(root, policy.rules, {
    ...context,
    sha: await currentGitSha(shaRoot),
  });
}

export const stopHandler: Handler = async (event: HarnessEvent, ctx: HandlerContext): Promise<Decision> => {
  const { policy, capabilities } = ctx;
  const root = event.projectDir;
  const shaRoot = shaScopeRoot(event);
  const provider = event.provider;
  const sessionKey = event.sessionKey;
  const session = sessionIdFromKey(event);
  const status = event.status ?? "completed";
  const maxLoops = policy.grind.maxLoops;
  const loopCount = capabilities.nativeLoopCounter
    ? (event.loopCount ?? 0)
    : coreFacade.turn.nextLoop(root, sessionKey);

  /**
   * why: the stop reads the handoff to decide rather than to tell the model, so a diverged file is a different
   * risk — a decision taken from planted text. Withholding here means deciding from the file's absence, which is
   * the same answer a first turn gets ([/decisions/ad-080.md](/decisions/ad-080.md)).
   */
  const stopSeal = coreFacade.handoff.handoffInjectable(root, sessionKey);
  const handoff = stopSeal.ok
    ? coreFacade.handoff.readHandoff(root, provider, sessionKey)
    : ({} as ReturnType<typeof coreFacade.handoff.readHandoff>);
  // hazard: read before the file list, because the list is diffed against it. A turn that commits moves `HEAD`
  // past its own changes, and every gate below then saw an empty diff and skipped — the comment gate in a repo
  // whose task was "schema v2 + tests + commit" ([/decisions/ad-058.md](/decisions/ad-058.md)).
  //
  // invariant: absent, this is the string `HEAD`, which is exactly the previous behaviour.
  const turnBase = handoff.turn_base_sha ?? "HEAD";
  /**
   * why: collected rather than returned. A turn may defer more than one gate to the same neighbour, and the reply
   * says so once at the end instead of three times ([/decisions/ad-073.md](/decisions/ad-073.md)).
   */
  const deferred: string[] = [];
  const changedFiles = await listChangedRepoFiles(root, turnBase);
  const codeTargets = filterCodeTargets(changedFiles, policy.codePaths);
  const testTargets = filterTestTargets(changedFiles);
  // why: the comment rail scopes by the syntax catalog (40+ languages), not `codeTargets`'s nine-extension
  // regex — a Terraform/SQL-heavy project changed no file that regex would keep, so the rail never ran.
  // Scoped to `codePaths` here, not inside `filterCommentTargets`, to avoid an import cycle through `policy.loader.ts`.
  const commentScope = changedFiles.filter((file) =>
    coreFacade.policy.isUnderCodePaths(file, policy.codePaths),
  );
  // why: `unknown_extensions` reports over `commentScope` (broader), not this — a language gap is still named
  // even after this excludes it from the scan.
  const commentTargets = coreFacade.commentPolicy.filterCommentTargets(commentScope);
  // why: read from the snapshot taken before this handler patches anything, so a credit written by the previous
  // stop is still visible when the gate it belongs to runs below.
  const pendingCredit = handoff.pending_lesson_credit;

  await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
    slice: { last_stop_status: status, last_changed_files: changedFiles, last_gate_result: "skipped" },
  });

  const skipVerify = existsSync(join(flagsDir(root), "skip-verify"));
  const cap = coreFacade.turn.checkLoopCap(loopCount, maxLoops);

  if (skipVerify || status !== "completed" || cap.capReached) {
    if (cap.capReached) {
      await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
        slice: {
          blockers: `Grind cap hit (${maxLoops} stop loops). Fix manually or pause gates.`,
          next_action: "Inspect failures, fix root cause, then continue.",
          last_failure_category: "budget",
        },
      });
    }
    return { kind: "abstain" };
  }

  const intel = policy.intelligence;
  const unfinishedWork = Boolean(handoff.blockers) || Boolean(handoff.previous_gaps?.length);
  if (
    intel.idleTurnGate &&
    coreFacade.turn.endedWithoutActing({
      activity: coreFacade.turn.readTurnActivity(root, event.sessionKey),
      changedFiles: changedFiles.length,
      hasOpenWork: unfinishedWork,
    })
  ) {
    // hazard: this used to write `blockers`, which is one of the four fields `unfinishedWork` reads — so one
    // firing manufactured its own precondition and the rail then blocked every later turn regardless of what the
    // agent did. Two defects compounded: the activity counter could not rise either, so nothing cleared it and
    // the operator saw the same BLOCKED four times in a row ([/decisions/ad-059.md](/decisions/ad-059.md)).
    //
    // invariant: this rail records what it saw and never writes a field it reads. `next_action` is not one of
    // them, and the follow-up text carries the instruction anyway.
    await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
      slice: {
        last_failure_category: "agent-quality",
        next_action: "Attempt the work, or proceed under a stated assumption.",
      },
    });
    return { kind: "continue", text: coreFacade.turn.idleTurnMessage() };
  }

  const budgetPressure =
    loopCount >= intel.budgetContinueAfterLoops ||
    (typeof event.contextUsagePercent === "number" && event.contextUsagePercent >= 85);

  if (intel.budgetContinue && unfinishedWork && budgetPressure) {
    await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
      slice: {
        last_failure_category: "budget",
        next_action: coreFacade.turn.suggestionFor("budget", "budget"),
        blockers: handoff.blockers ?? "Budget/continue signal: do not end early.",
      },
    });
    return {
      kind: "continue",
      text: [
        "BLOCKED: continue working — do not summarize or end this turn early.",
        `TRIED: stop loop ${loopCount}.`,
        `NEED: ${coreFacade.turn.suggestionFor("budget", "budget")}`,
      ].join("\n"),
    };
  }

  if (policy.grind.enabled && policy.grind.lintCommand && codeTargets.length > 0) {
    const run = await runLockedGate({
      root,
      shaRoot,
      provider,
      session,
      pendingCredit,
      sessionKey,
      policy,
      gate: "lint",
      command: policy.grind.lintCommand,
      argvFiles: coreFacade.gate.shouldAppendFiles(policy.grind.lintCommand, policy.grind.appendFiles)
        ? codeTargets
        : [],
      recordFiles: codeTargets,
    });
    if (run.kind === "deferred") {
      deferred.push(run.holder);
    } else if (!run.artifact.passed) {
      return failGate({
        root,
        provider,
        sessionKey,
        gate: "lint",
        artifact: run.artifact,
        loopCount,
        maxLoops,
        policy,
      });
    }
  }

  if (policy.grind.enabled && policy.grind.testCommand) {
    // why: changed code is enough, at every posture. The narrow form ran the suite only when a test file changed,
    // which skips exactly the change that most needs testing — and it made verification depend on a surfacing
    // preference. Still gated by grind.enabled.
    const shouldRunTests = testTargets.length > 0 || codeTargets.length > 0;
    if (shouldRunTests) {
      const recordFiles = testTargets.length > 0 ? testTargets : codeTargets;
      const run = await runLockedGate({
        root,
        shaRoot,
        provider,
        session,
        pendingCredit,
        sessionKey,
        policy,
        gate: "test",
        command: policy.grind.testCommand,
        argvFiles: coreFacade.gate.shouldAppendFiles(policy.grind.testCommand, policy.grind.appendFiles)
          ? testTargets
          : [],
        recordFiles,
      });
      if (run.kind === "deferred") {
        deferred.push(run.holder);
      } else if (!run.artifact.passed) {
        return failGate({
          root,
          provider,
          sessionKey,
          gate: "test",
          artifact: run.artifact,
          loopCount,
          maxLoops,
          policy,
        });
      }
    }
  }

  // invariant: observation runs before the enforcing branch and returns nothing. It answers the question a firing
  // rate cannot — was the rule ever needed — by running the checker while the prose is absent. A measurement that
  // can change what it measures is not a measurement ([/decisions/ad-027.md](/decisions/ad-027.md)).
  if (
    commentTargets.length > 0 &&
    coreFacade.observe.shouldObserve(policy.observe, "comments", policy.comments.enabled)
  ) {
    const hits = await coreFacade.commentPolicy.scanAddedComments(
      root,
      commentTargets,
      policy.comments.mode,
      turnBase,
    );
    coreFacade.observability.recordObs(root, obsConfigFor(policy), {
      provider,
      kind: "policy.observe",
      sessionKey,
      attrs: {
        ...coreFacade.observe.observeAttrs({
          rail: "comments",
          violations: hits.length,
          proseInjected: policy.comments.enabled,
        }),
        rule: "comments",
        // why: a language the catalog does not carry produces no findings, which reads identically to "the
        // property held". Naming the extensions is the difference between a clean reading and a blind spot.
        // Scoped to `commentScope`, not `commentTargets` — the target set is already syntax-known by
        // construction, so it could never report the gap it exists to name.
        unknown_extensions: coreFacade.commentPolicy.unknownExtensions(commentScope).join(",") || "none",
      },
    });
  }

  if (policy.comments.enabled && policy.comments.onViolation === "followup" && commentTargets.length > 0) {
    const hits = await coreFacade.commentPolicy.scanAddedComments(
      root,
      commentTargets,
      policy.comments.mode,
      turnBase,
    );
    if (hits.length > 0) {
      await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
        slice: {
          last_gate_result: "fail",
          blockers: `This turn added ${hits.length} undeclared comment line(s).`,
          next_action: coreFacade.turn.suggestionFor("verification", "comments"),
        },
      });
      return {
        kind: "continue",
        text: coreFacade.commentPolicy.commentViolationMessage(hits, policy.comments.mode),
      };
    }
  }

  /**
   * why: a dependency added in a turn is code that runs on every later turn, in CI, and on every machine that
   * installs the project. Two mechanical failures are worth a stop: a manifest that moved without its lockfile,
   * and a specifier that names no version ([/decisions/ad-075.md](/decisions/ad-075.md)).
   */
  if (policy.supplyChain.enabled && changedFiles.length > 0) {
    const manifests = changedFiles.filter((path) => coreFacade.supplyChain.isManifest(path));
    if (manifests.length > 0) {
      const added = await listAddedLines(root, manifests, turnBase);
      const outcome = coreFacade.supplyChain.inspectSupplyChain({
        changedFiles,
        added,
        readManifest: (relativePath) => {
          try {
            return readFileSync(join(root, relativePath), "utf8");
          } catch {
            return null;
          }
        },
      });
      if (outcome.findings.length > 0) {
        await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
          slice: {
            last_gate_result: "fail",
            blockers: `This turn changed the dependency graph in ${outcome.findings.length} way(s) that outlive it.`,
            next_action: coreFacade.turn.suggestionFor("verification", "supplyChain"),
          },
        });
        return {
          kind: "continue",
          text: coreFacade.supplyChain.supplyChainMessage(outcome.findings),
        };
      }
    }
  }

  /**
   * why: the same diff scope the comment gate uses, asking a different question — did this turn write something
   * the project already has? Two copies of a run drift apart, and the second copy is where the drift starts
   * ([/decisions/ad-071.md](/decisions/ad-071.md)).
   */
  if (policy.duplication.enabled && codeTargets.length > 0) {
    const added = await listAddedLines(root, codeTargets, turnBase);
    const tracked = await listTrackedFiles(root);
    const scan = coreFacade.duplication.scanProject(
      tracked,
      (relativePath) => {
        try {
          return readFileSync(join(root, relativePath), "utf8");
        } catch {
          return null;
        }
      },
      policy.duplication.minRun,
    );
    const hits = coreFacade.duplication.findDuplications(added, scan.index, policy.duplication.minRun);
    if (hits.length > 0) {
      await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
        slice: {
          last_gate_result: "fail",
          blockers: `This turn added ${hits.length} run(s) the project already has.`,
          next_action: coreFacade.turn.suggestionFor("verification", "duplication"),
        },
      });
      return { kind: "continue", text: coreFacade.duplication.duplicationMessage(hits) };
    }
  }

  // invariant: this is the grind pattern. The project brings the structural tool — drift, oasdiff, ast-grep
  // — and the harness runs it through the same lock, artifact writer and failure path as lint and test.
  // Inferring staleness from directory mapping was measured at 82-100% false reports and removed.
  if (policy.docs.command && policy.docs.command.length > 0) {
    const run = await runLockedGate({
      root,
      shaRoot,
      provider,
      session,
      pendingCredit,
      sessionKey,
      policy,
      gate: "docs",
      command: policy.docs.command,
      argvFiles: [],
      recordFiles: changedFiles,
    });
    if (run.kind === "deferred") {
      deferred.push(run.holder);
    } else if (!run.artifact.passed) {
      if (policy.docs.severity === "deny") {
        return failGate({
          root,
          provider,
          sessionKey,
          gate: "docs",
          artifact: run.artifact,
          loopCount,
          maxLoops,
          policy,
        });
      }
      return {
        kind: "context",
        text: [
          "ADVISORY: the documentation gate reported.",
          `TRIED: ${policy.docs.command.join(" ")}`,
          "NEED: update what it names, or accept it knowingly — this does not block the stop.",
          "",
          run.artifact.outputTail,
        ].join("\n"),
      };
    }
  }

  // invariant: the plan gate runs before the ship gate. A turn that changed files nobody planned has an
  // invalid scope, which makes any evidence it produced evidence for the wrong change.
  const planDecision = coreFacade.plan.evaluatePlanGate({
    enabled: policy.planGate.enabled,
    declaredAt: handoff.plan_at,
    windowMinutes: policy.planGate.windowMinutes,
    planned: handoff.plan_paths ?? [],
    deviations: handoff.plan_deviations ?? [],
    changedFiles,
  });
  if (planDecision.kind !== "abstain") {
    await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
      slice: {
        last_gate_result: "fail",
        last_failure_category: "policy",
        blockers: "Changed files fall outside the declared HARNESS_PLAN.",
        next_action: "Revert what the plan did not call for, or justify each path with a stated reason.",
      },
    });
    return planDecision;
  }

  const recentShipClaim =
    handoff.last_ship_claim_kind === "structured" &&
    coreFacade.ship.recentShipClaimActive(handoff.last_ship_claim_at, policy.shipGate.claimWindowMinutes);

  const emptyDiffDecision = coreFacade.ship.evaluateEmptyDiffAntiShip({
    enabled: policy.shipGate.enabled && policy.shipGate.emptyDiffAntiShip,
    recentShipClaim,
    changedFilesCount: changedFiles.length,
  });
  if (emptyDiffDecision.kind !== "abstain") {
    await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
      slice: {
        last_gate_result: "fail",
        blockers: "Structured ship claim with empty diff.",
        next_action: coreFacade.turn.suggestionFor("ship-evidence", "empty-diff"),
      },
    });
    coreFacade.ship.appendShipLedger(root, {
      provider,
      event: "challenge",
      claimKind: "structured",
      gate: "empty-diff",
      detail: handoff.last_ship_claim_snippet,
    });
    return emptyDiffDecision;
  }

  const shipEvidenceDecision = coreFacade.ship.evaluateShipEvidenceGate({
    enabled: policy.shipGate.enabled,
    recentShipClaim,
    changedFiles,
    runtimePathPrefixes: policy.shipGate.runtimePathPrefixes,
    runtimePathExcludes: policy.shipGate.runtimePathExcludes,
    evidenceDir: policy.shipGate.evidenceDir,
    evidenceMaxAgeHours: policy.shipGate.evidenceMaxAgeHours,
    // why: the changed-file list is already in hand, so ordering the evidence against the code costs a stat per
    // file and no git call.
    evidenceNotBeforeMs: coreFacade.ship.newestChangeMs(root, changedFiles),
  });
  if (shipEvidenceDecision.kind !== "abstain") {
    await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
      slice: {
        last_gate_result: "fail",
        blockers: "HARNESS_SHIP_CLAIM without recent production evidence on runtime changes.",
        next_action: coreFacade.turn.suggestionFor("ship-evidence", "ship"),
      },
    });
    coreFacade.ship.appendShipLedger(root, {
      provider,
      event: "challenge",
      claimKind: "structured",
      gate: "ship",
      files: changedFiles.slice(0, 12),
      evidenceDir: policy.shipGate.evidenceDir,
      detail: handoff.last_ship_claim_snippet,
    });
    return shipEvidenceDecision;
  }

  if (
    policy.shipGate.enabled &&
    recentShipClaim &&
    policy.shipGate.evidenceDir &&
    coreFacade.ship.hasRecentEvidence(policy.shipGate.evidenceDir, policy.shipGate.evidenceMaxAgeHours)
  ) {
    coreFacade.ship.appendShipLedger(root, {
      provider,
      event: "pass",
      claimKind: "structured",
      gate: "ship",
      evidenceDir: policy.shipGate.evidenceDir,
      detail: handoff.last_ship_claim_snippet,
    });
  }

  /**
   * The operator's own bar, last among the blockers so every gate the harness owns has already spoken — and after
   * the gates specifically, because a rule asking for `gate(lint) since HEAD` can only be satisfied once lint has
   * run this turn ([/decisions/ad-100.md](/decisions/ad-100.md)).
   *
   * invariant: `warn` returns `context`, which does not block. Everything else refuses the stop, so a rule the
   * operator wrote cannot be ended past.
   */
  const stopRules = await decideStopRules(root, shaRoot, policy, sessionKey);
  if (stopRules.decision.kind !== "abstain") {
    if (stopRules.decision.kind !== "context") {
      const worst = coreFacade.rules.strictest(stopRules.outcomes);
      await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
        slice: {
          last_gate_result: "fail",
          last_failure_category: "policy",
          blockers: `Rule ${worst?.rule.name ?? "unknown"} is not satisfied for this HEAD.`,
          next_action: worst?.missing.length
            ? `Produce ${worst.missing.join(", ")}, then stop again.`
            : "Satisfy the rule named in the follow-up, then stop again.",
        },
      });
    }
    return stopRules.decision;
  }

  // why: the pairing of a failure with what resolved it is captured here, immediately before the record that
  // holds the failure identity is cleared. This is the one moment both halves exist
  // ([/decisions/ad-028.md](/decisions/ad-028.md)).
  if (handoff.last_fingerprint && handoff.last_gate_result === "fail" && changedFiles.length > 0) {
    coreFacade.stagnation.recordResolution(root, handoff.last_fingerprint, {
      files: changedFiles,
      at: new Date().toISOString(),
      gate: handoff.last_failure_category ?? "gate",
    });
  }

  coreFacade.stagnation.clearFingerprint(root, sessionKey);
  coreFacade.shellPolicy.clearShellStall(root, sessionKey);
  coreFacade.turn.resetLoop(root, sessionKey);
  /**
   * invariant: a deferred gate is `skipped`, never `pass`. Nothing verified this turn — a neighbour session is
   * verifying the same tree — and writing `pass` would put a verdict in the handoff that no gate produced
   * ([/decisions/ad-073.md](/decisions/ad-073.md)).
   *
   * why: recorded and not narrated. `continue` is the only stop-time channel that carries text and it renders as
   * `{"decision":"block"}`, so telling the turn would mean blocking it — the defect being fixed. `gate.outcome` is
   * a `why` kind, so `tlc harness why` answers it after the fact.
   */
  const holders = [...new Set(deferred)];
  await coreFacade.handoff.patchHandoff(root, provider, sessionKey, {
    slice: {
      last_gate_result: holders.length > 0 ? "skipped" : "pass",
      blockers: undefined,
      previous_gaps: undefined,
      last_failure_category: undefined,
      next_action:
        holders.length > 0
          ? `The grind gate deferred to ${holders.join(", ")} — that session is running it over this tree.`
          : changedFiles.length > 0
            ? "Continue or commit when ready."
            : undefined,
      fingerprint_hits: 0,
    },
  });
  return { kind: "abstain" };
};

if (import.meta.main) {
  await main(stopHandler);
}
