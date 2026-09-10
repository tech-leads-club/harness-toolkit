// why: `stop` was the only place these checks could refuse a turn, so `push`/`gh pr create` mid-turn
// always shipped first and learned about the violation afterward. Same checks, before ship, identical
// on Claude and Cursor — every input read here is host-neutral ([/decisions/ad-116.md](/decisions/ad-116.md)).
import { readFileSync } from "node:fs";
import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import { listAddedLines, listTrackedFiles, localRepoRemote } from "../platform/git.ts";
import type { HandlerContext } from "./run.ts";
import { runLockedGate } from "./stop.ts";
import {
  computeTurnScope,
  currentGitSha,
  pendingCommentViolations,
  sessionIdFromKey,
  shaScopeRoot,
} from "./support.ts";

// why: pr-merge is the moment code actually lands on the shared branch. Usually no local diff exists at merge
// time, so the battery abstains — the merged commits already paid it at push/pr-open time
// ([/decisions/ad-128.md](/decisions/ad-128.md)).
const FULL_BATTERY_KINDS = ["push", "pr-open", "pr-merge"] as const;

/**
 * why a cheap pass first: `localRepoRemote` is a process spawn, and this runs on every shell command. The
 * gh-api shape only needs it to disambiguate an unrelated repository's push from this project's own
 * ([/decisions/ad-130.md](/decisions/ad-130.md)); a CLI-shape match or no match at all never pays for it.
 */
async function isShipCommand(event: HarnessEvent, gitRoot: string): Promise<boolean> {
  if (event.command === undefined) {
    return false;
  }
  const context = { event: event.event, command: event.command };
  if (!FULL_BATTERY_KINDS.some((kind) => coreFacade.rules.triggerMatches({ kind }, context))) {
    return false;
  }
  // why: a CLI shape (`gh pr create`, `git push`) never reads `repoRemote` — only a `gh api` call can, so a
  // command that never mentions one already has its final answer.
  if (!coreFacade.rules.mentionsGhApi(event.command)) {
    return true;
  }
  const repoRemote = await localRepoRemote(gitRoot);
  return FULL_BATTERY_KINDS.some((kind) =>
    coreFacade.rules.triggerMatches({ kind }, { ...context, repoRemote }),
  );
}

function gateFailureMessage(
  gate: string,
  command: readonly string[],
  outputTail: string,
  diag: ReturnType<typeof coreFacade.diagnostics.rootDiagnostic>,
): string {
  return [
    `BLOCKED: ${gate} failed before shipping — a review or a deploy would have seen this next.`,
    `TRIED: ${command.join(" ")}`,
    `NEED: fix the ${gate} findings, then retry the commit/push/PR.`,
    "",
    outputTail,
    "",
    diag.footer,
  ].join("\n");
}

/**
 * why after comments and before the stop-rules check: cheapest first. A comment violation costs a
 * regex scan; a gate command is a real process; the stop-rules check is a directory read plus, only
 * once something fired, one `git rev-parse`.
 */
export async function shipGateVerdict(event: HarnessEvent, ctx: HandlerContext): Promise<Decision> {
  const shaRoot = shaScopeRoot(event);
  if (!(await isShipCommand(event, shaRoot))) {
    return { kind: "abstain" };
  }
  const { policy } = ctx;
  const root = event.projectDir;
  const provider = event.provider;
  const sessionKey = event.sessionKey;
  const session = sessionIdFromKey(event);
  const scope = await computeTurnScope(root, shaRoot, provider, sessionKey, policy);
  const rootDiag = coreFacade.diagnostics.rootDiagnostic(shaRoot);

  const commentHits = await pendingCommentViolations(root, shaRoot, provider, sessionKey, policy);
  if (commentHits.length > 0) {
    const diag = coreFacade.diagnostics.diffDiagnostic(shaRoot, await currentGitSha(shaRoot), commentHits);
    return {
      kind: "deny",
      reason: `${coreFacade.commentPolicy.commentViolationMessage(commentHits, policy.comments.mode)}\n\n${diag.footer}`,
      rule: "ship-gate-comments",
      diagnostic: diag.summary,
    };
  }

  if (policy.grind.enabled && policy.grind.lintCommand && scope.codeTargets.length > 0) {
    const run = await runLockedGate({
      root,
      shaRoot,
      provider,
      session,
      pendingCredit: scope.pendingCredit,
      sessionKey,
      policy,
      gate: "lint",
      command: policy.grind.lintCommand,
      argvFiles: coreFacade.gate.shouldAppendFiles(policy.grind.lintCommand, policy.grind.appendFiles)
        ? scope.codeTargets
        : [],
      recordFiles: scope.codeTargets,
    });
    if (run.kind === "ran" && !run.artifact.passed) {
      return {
        kind: "deny",
        reason: gateFailureMessage("lint", run.artifact.command, run.artifact.outputTail, rootDiag),
        rule: "ship-gate-lint",
        diagnostic: rootDiag.summary,
      };
    }
  }

  if (
    policy.grind.enabled &&
    policy.grind.testCommand &&
    (scope.testTargets.length > 0 || scope.codeTargets.length > 0)
  ) {
    const recordFiles = scope.testTargets.length > 0 ? scope.testTargets : scope.codeTargets;
    const run = await runLockedGate({
      root,
      shaRoot,
      provider,
      session,
      pendingCredit: scope.pendingCredit,
      sessionKey,
      policy,
      gate: "test",
      command: policy.grind.testCommand,
      argvFiles: coreFacade.gate.shouldAppendFiles(policy.grind.testCommand, policy.grind.appendFiles)
        ? recordFiles
        : [],
      recordFiles,
    });
    if (run.kind === "ran" && !run.artifact.passed) {
      return {
        kind: "deny",
        reason: gateFailureMessage("test", run.artifact.command, run.artifact.outputTail, rootDiag),
        rule: "ship-gate-test",
        diagnostic: rootDiag.summary,
      };
    }
  }

  if (policy.docs.command && policy.docs.command.length > 0 && policy.docs.severity === "deny") {
    const run = await runLockedGate({
      root,
      shaRoot,
      provider,
      session,
      pendingCredit: scope.pendingCredit,
      sessionKey,
      policy,
      gate: "docs",
      command: policy.docs.command,
      argvFiles: [],
      recordFiles: scope.changedFiles,
    });
    if (run.kind === "ran" && !run.artifact.passed) {
      return {
        kind: "deny",
        reason: gateFailureMessage("docs", run.artifact.command, run.artifact.outputTail, rootDiag),
        rule: "ship-gate-docs",
        diagnostic: rootDiag.summary,
      };
    }
  }

  if (policy.duplication.enabled && scope.codeTargets.length > 0) {
    const added = await listAddedLines(shaRoot, scope.codeTargets, scope.turnBase);
    const tracked = await listTrackedFiles(shaRoot);
    const scan = coreFacade.duplication.scanProject(
      tracked,
      (relativePath) => {
        try {
          return readFileSync(`${shaRoot}/${relativePath}`, "utf8");
        } catch {
          return null;
        }
      },
      policy.duplication.minRun,
    );
    const hits = coreFacade.duplication.findDuplications(added, scan.index, policy.duplication.minRun);
    if (hits.length > 0) {
      const diag = coreFacade.diagnostics.diffDiagnostic(shaRoot, await currentGitSha(shaRoot), hits);
      return {
        kind: "deny",
        reason: `${coreFacade.duplication.duplicationMessage(hits)}\n\n${diag.footer}`,
        rule: "ship-gate-duplication",
        diagnostic: diag.summary,
      };
    }
  }

  const sha = await currentGitSha(shaRoot);
  const stopRules = coreFacade.rules.decideStop(root, policy.rules, {
    sessionKey,
    mode: policy.mode,
    sha,
    shaRoot,
  });
  const worst = coreFacade.rules.strictest(stopRules.outcomes);
  if (worst && worst.verdict !== "warn") {
    return { kind: "deny", reason: worst.message, rule: `rule:${worst.rule.name}` };
  }

  return { kind: "abstain" };
}
