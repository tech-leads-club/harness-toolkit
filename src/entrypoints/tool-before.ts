import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import type { AddedLine } from "../platform/git.ts";
import { diffProposedAgainstDisk, diffTwoStrings, localRepoRemote } from "../platform/git.ts";
import { normalizeSeparators } from "../platform/sanitize.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import { shipGateVerdict } from "./ship-gate.ts";
import {
  currentGitSha,
  obsConfigFor,
  pendingCommentViolations,
  readModelFromToolInput,
  shaScopeRoot,
  subagentSpawnInput,
} from "./support.ts";

/**
 * why `commit` gets only the cheap check and `push`/`pr-open` get the full battery
 * (`shipGateVerdict`): measured in this repo, lint+test run ~9.4s cold — paying that on every local
 * commit inside one turn is the edit-time cost AD-111 already declined, moved to a higher frequency.
 * A bare commit is local and reversible; nothing shares it yet ([/decisions/ad-116.md](/decisions/ad-116.md)).
 */
async function commentGateBeforeCommit(event: HarnessEvent, ctx: HandlerContext): Promise<Decision> {
  if (event.command === undefined) {
    return { kind: "abstain" };
  }
  const context = { event: event.event, command: event.command };
  if (!coreFacade.rules.triggerMatches({ kind: "commit" }, context)) {
    return { kind: "abstain" };
  }
  const shaRoot = await shaScopeRoot(event);
  const hits = await pendingCommentViolations(
    event.projectDir,
    shaRoot,
    event.provider,
    event.sessionKey,
    ctx.policy,
  );
  if (hits.length === 0) {
    return { kind: "abstain" };
  }
  const diag = coreFacade.diagnostics.diffDiagnostic(shaRoot, await currentGitSha(shaRoot), hits);
  return {
    kind: "deny",
    reason: `${coreFacade.commentPolicy.commentViolationMessage(hits, ctx.policy.comments.mode)}\n\n${diag.footer}`,
    rule: "comment-policy-before-ship",
    diagnostic: diag.summary,
  };
}

/**
 * hazard: `new_string` routinely carries lines copied verbatim from `old_string` — Claude's own Edit tool
 * asks for surrounding context to make `old_string` unique. Treating every `new_string` line as added
 * flagged a pre-existing comment the model never touched. Diffing `oldContent` against `newContent` (the
 * same real-diff machinery `diffProposedAgainstDisk` already uses) isolates only what actually changed.
 *
 * why: `old_string`'s own start line, located on disk, offsets the diff's line numbers onto the real file —
 * `new_string` is not at line 1, and `diskLineReader`'s JSDoc-identifier lookup needs the real line to read
 * the right context after it.
 */
async function editAddedLines(
  currentContent: string,
  oldContent: string,
  newContent: string,
  file: string,
): Promise<AddedLine[] | null> {
  const idx = currentContent.indexOf(oldContent);
  if (idx === -1) {
    return null;
  }
  const startLine = currentContent.slice(0, idx).split("\n").length;
  const diff = await diffTwoStrings(oldContent, newContent, file);
  return diff.map((line) => ({ ...line, line: line.line + startLine - 1 }));
}

/**
 * why after `commentGateBeforeCommit`, before `shipGuard`: same tier — a built-in capability check, reads
 * policy, not operator-authored ([/decisions/ad-115.md](/decisions/ad-115.md)).
 */
async function commentGateBeforeEdit(event: HarnessEvent, ctx: HandlerContext): Promise<Decision> {
  const { policy } = ctx;
  if (!policy.comments.enabled || policy.comments.onViolation !== "followup") {
    return { kind: "abstain" };
  }
  if (event.proposedContent === undefined || event.proposedContent === "") {
    return { kind: "abstain" };
  }
  const filePath = filePathOf(event);
  if (!filePath) {
    return { kind: "abstain" };
  }
  // why: a Write/Edit `tool_input.file_path` arrives relative to the project root, not to this process's own
  // cwd — resolving it first is `resolveTarget`'s own approach (`src/core/floor/floor.paths.ts`); `relative()`
  // alone treats a bare relative path as relative to `process.cwd()`, which only happens to equal `projectDir`
  // when a real hook process's cwd was set there.
  const absoluteFilePath = isAbsolute(filePath) ? filePath : resolve(event.projectDir, filePath);
  const relativePath = normalizeSeparators(relative(event.projectDir, absoluteFilePath));
  if (relativePath.startsWith("..") || !coreFacade.policy.isUnderCodePaths(relativePath, policy.codePaths)) {
    return { kind: "abstain" };
  }
  if (coreFacade.commentPolicy.filterCommentTargets([relativePath]).length === 0) {
    return { kind: "abstain" };
  }

  // why: `relativePath` was just computed against `event.projectDir`, not any resolved git root — a
  // monorepo package whose `projectDir` sits below the repo's real root joined it onto the wrong base and
  // either read the wrong file or, worse, read nothing and silently treated an existing file as brand new.
  let added: AddedLine[];
  let nextCodeLine: ((file: string, line: number) => string | undefined) | undefined;

  if (event.toolName === "Write") {
    added = await diffProposedAgainstDisk(event.projectDir, relativePath, event.proposedContent);
    const proposedLines = event.proposedContent.split("\n");
    nextCodeLine = (_file, line) => proposedLines[line - 1];
  } else if (event.toolName === "Edit" && event.proposedOldContent !== undefined) {
    let currentContent: string;
    try {
      currentContent = readFileSync(join(event.projectDir, relativePath), "utf8");
    } catch {
      return { kind: "abstain" };
    }
    const edited = await editAddedLines(
      currentContent,
      event.proposedOldContent,
      event.proposedContent,
      relativePath,
    );
    if (edited === null) {
      return { kind: "abstain" };
    }
    added = edited;
    nextCodeLine = coreFacade.commentPolicy.diskLineReader(event.projectDir);
  } else {
    return { kind: "abstain" };
  }

  const hits = coreFacade.commentPolicy.findAddedComments(added, policy.comments.mode, nextCodeLine);
  if (hits.length === 0) {
    return { kind: "abstain" };
  }
  // why: every deny in this battery names what it checked and points at `tlc harness why`
  // ([/decisions/ad-131.md](/decisions/ad-131.md)) — this one has no commit sha to reproduce against, so
  // it names the directory it checked, the same minimal form `rootDiagnostic` already gives a gate failure.
  const diag = coreFacade.diagnostics.rootDiagnostic(event.projectDir);
  return {
    kind: "deny",
    reason: `${coreFacade.commentPolicy.commentViolationMessage(hits, policy.comments.mode)}\n\n${diag.footer}`,
    rule: "comment-policy-before-edit",
    diagnostic: diag.summary,
  };
}

const READONLY_BLOCKED_TOOLS = new Set(["Write", "Delete", "Shell"]);

/**
 * hazard: `attrs.permission` was read in two places and written in none. `observability.service.ts` increments
 * `shell.ask`/`shell.deny` from it, `observability.types.ts` grades an event `signal` when it is not `allow`, and
 * the session report prints `Shell allow/ask/deny` — so both counters were structurally zero and the report
 * printed a truthful-looking `0` for every ask that ever happened. Obs was emitted only on `*.after` events,
 * which means the moment a decision is made was the one moment never recorded.
 *
 * why: the base config leaves `debugEnabled` false, and an `allow` grades as debug. So an allow is computed and
 * dropped — costing nothing in the common path — while asks and denials reach disk. `shell.allow` keeps coming
 * from `shell.end`, so nothing is double-counted.
 *
 * invariant: recorded after the decision and never able to change it. A rail that measures interruptions must not
 * become one.
 */
function recordShellDecision(event: HarnessEvent, ctx: HandlerContext, decision: Decision): void {
  coreFacade.observability.recordObs(event.projectDir, obsConfigFor(ctx.policy), {
    provider: event.provider,
    kind: "shell.start",
    sessionKey: event.sessionKey,
    model: event.model,
    attrs: {
      command: event.command,
      permission: decision.kind,
      posture: ctx.policy.mode,
      // why: unattributed rather than guessed. A rate an operator cannot trace to a switch is a number, not a
      // signal.
      rule: "rule" in decision && decision.rule ? decision.rule : "none",
      diagnostic: "diagnostic" in decision && decision.diagnostic ? decision.diagnostic : "none",
    },
  });
}

function recordShellDecisionIfShell(event: HarnessEvent, ctx: HandlerContext, decision: Decision): void {
  if (event.event === "shell.before") {
    recordShellDecision(event, ctx, decision);
  }
}

/**
 * why the sha is read here and not in `run.ts`: `git rev-parse` is a process spawn, and this fires on every tool
 * call. It is asked for only once a rule has actually fired, so an operator who declared nothing pays nothing
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
async function rulesDecision(event: HarnessEvent, ctx: HandlerContext): Promise<Decision> {
  const config = ctx.policy.rules;
  const trigger = {
    event: event.event,
    toolName: event.toolName,
    command: event.command,
    toolInput: event.toolInput,
  };
  const shaRoot = await shaScopeRoot(event);
  const dryRun = coreFacade.rules.decideAction(event.projectDir, config, trigger, {
    sha: null,
    sessionKey: event.sessionKey,
    mode: ctx.policy.mode,
    shaRoot,
  });
  if (dryRun.outcomes.length === 0) {
    return { kind: "abstain" };
  }
  // why: the first pass answers whether any rule fired at all, which costs no git. The remote is a second
  // process, spent only when the command could possibly be a gh api call naming a different repository
  // ([/decisions/ad-130.md](/decisions/ad-130.md)) — a CLI shape or an unrelated trigger never reads it.
  const [sha, repoRemote] = await Promise.all([
    currentGitSha(shaRoot),
    (event.command && coreFacade.rules.mentionsGhApi(event.command)) ||
    coreFacade.rules.mentionsMcpAct(event.toolName)
      ? localRepoRemote(shaRoot)
      : undefined,
  ]);
  const verdict = coreFacade.rules.decideAction(
    event.projectDir,
    config,
    { ...trigger, repoRemote },
    {
      sha,
      sessionKey: event.sessionKey,
      mode: ctx.policy.mode,
      shaRoot,
    },
  );
  return verdict.decision;
}

function handleShellBefore(event: HarnessEvent, ctx: HandlerContext): Decision {
  const { policy } = ctx;
  const decision = coreFacade.shellPolicy.evaluateShellCommand({
    command: event.command ?? "",
    sessionKey: event.sessionKey,
    projectDir: event.projectDir,
    mode: policy.mode,
    catastrophicAsk: policy.shell.catastrophicAsk,
    stallDetection: policy.shell.stallDetection,
    stallRepeatThreshold: policy.shell.stallRepeatThreshold,
  });
  recordShellDecision(event, ctx, decision);
  return decision;
}

// why: a read cannot mutate the policy surface, so it is the one class of event that stays available while a
// divergence is unresolved. Without it the agent cannot even read the file that explains the block.
function isReadOnlyEvent(event: HarnessEvent): boolean {
  return event.event === "read.before" || event.event === "mcp.before";
}

function filePathOf(event: HarnessEvent): string | undefined {
  if (event.filePath) {
    return event.filePath;
  }
  const fromInput = event.toolInput?.file_path;
  return typeof fromInput === "string" ? fromInput : undefined;
}

async function handleToolBefore(event: HarnessEvent, ctx: HandlerContext): Promise<Decision> {
  const { policy, provider } = ctx;

  const isReadOnlySubagent =
    event.subagentType !== undefined && policy.subagents.readOnlyTypes.includes(event.subagentType);
  if (isReadOnlySubagent && event.toolName !== undefined && READONLY_BLOCKED_TOOLS.has(event.toolName)) {
    return {
      kind: "deny",
      reason: `Explore/read-only subagents cannot use ${event.toolName}. Return findings to the parent agent.`,
      rule: "subagent-read-only",
    };
  }

  if (event.toolName === "Task") {
    const model = event.spawnModel ?? readModelFromToolInput(event.toolInput);
    const spawnDecision = coreFacade.subagentPolicy.evaluateSubagentSpawn(
      subagentSpawnInput(event, policy, provider, model),
    );
    if (spawnDecision.kind !== "allow") {
      return spawnDecision;
    }
  }

  if (event.toolName === "Edit" || event.toolName === "Write") {
    const filePath = filePathOf(event);
    if (filePath) {
      const collision = coreFacade.presence.checkCollision(event.projectDir, filePath, event.sessionKey);
      if (collision.kind !== "allow") {
        return collision;
      }
    }
  }

  return { kind: "allow" };
}

// why: the one event a Cursor session ever reports a real cwd on — read back by `shaScopeRoot` at `stop`,
// which gets none at all ([/decisions/ad-145.md](/decisions/ad-145.md)). A no-op once the value already
// matches, so a session sitting in one directory pays this exactly once, not on every command.
async function recordShellCwd(event: HarnessEvent): Promise<void> {
  if (event.event !== "shell.before" || !event.cwd) {
    return;
  }
  const current = coreFacade.handoff.readHandoff(event.projectDir, event.provider, event.sessionKey);
  if (current.last_shell_cwd === event.cwd) {
    return;
  }
  await coreFacade.handoff.patchHandoff(event.projectDir, event.provider, event.sessionKey, {
    slice: { last_shell_cwd: event.cwd },
  });
}

export const toolBeforeHandler: Handler = async (
  event: HarnessEvent,
  ctx: HandlerContext,
): Promise<Decision> => {
  // why: an observation, not a decision — recorded before the floor so it is captured regardless of what
  // this specific command is ultimately allowed to do ([/decisions/ad-145.md](/decisions/ad-145.md)).
  await recordShellCwd(event);

  // invariant: the floor runs first and reads no policy, so no config value and no agent edit can
  // reach a decision before it.
  const floor = coreFacade.floor.evaluateFloor({
    projectDir: event.projectDir,
    toolName: event.toolName,
    filePath: filePathOf(event),
    command: event.command,
    isReadEvent: event.event === "read.before",
    protectedPaths: ctx.protectedPaths,
  });
  if (floor.kind !== "allow") {
    // invariant: one rail owns the record of every shell decision. The floor short-circuits before the shell
    // rail runs, so without this a floor denial of a shell command was recorded by nothing at all — and the
    // shared refusal path deliberately skips `shell.before` to avoid double-counting what this rail owns.
    recordShellDecisionIfShell(event, ctx, floor);
    return floor;
  }

  /**
   * why: after the floor, because the floor is unconditional and this is a rail. A command the floor already
   * refuses never needs an operator's opinion ([/decisions/ad-077.md](/decisions/ad-077.md)).
   */
  const untrustedAsk = coreFacade.untrusted.askIfFromUntrusted({
    root: event.projectDir,
    sessionKey: event.sessionKey,
    command: event.command,
    config: ctx.policy.untrustedContent,
  });
  if (untrustedAsk.kind !== "abstain") {
    return untrustedAsk;
  }

  // invariant: unconditional, for the same reason the floor is. This detects a policy that changed without
  // a harness command, so reading a policy field to decide whether to look would let the mutation switch
  // off its own detector.
  //
  // hazard: it used to deny every event, reads included, which left the agent unable to look at anything —
  // it could not diagnose the divergence or explain it, only go mute. Measured: it locked its own author out
  // of the file holding the fix. A read cannot change a policy, so reads pass and the agent can investigate
  // and report; everything that acts is still refused until the operator clears it.
  if (!isReadOnlyEvent(event)) {
    const integrity = coreFacade.policy.checkPolicyBaseline(event.projectDir, event.sessionKey);
    if (integrity.kind !== "allow") {
      recordShellDecisionIfShell(event, ctx, integrity);
      return integrity;
    }
  }

  /**
   * The operator's own rules, after the floor and after the integrity check, because both are unconditional and a
   * rail comes second ([/decisions/ad-077.md](/decisions/ad-077.md)).
   *
   * invariant: `deny` and `ask` answer here; `follow-up` and `warn` abstain and are the stop rail's business. With
   * the capability off, or with no rule files, `decideAction` reads two directory entries and abstains — which is
   * what keeps a machine that never opted in byte-identical to before ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  const rulesVerdict = await rulesDecision(event, ctx);
  if (rulesVerdict.kind !== "abstain") {
    recordShellDecisionIfShell(event, ctx, rulesVerdict);
    return rulesVerdict;
  }

  /**
   * why after the operator rules and before the shell fallback: a built-in capability check, not
   * operator-authored, so it is not a `.tlc/harness/rules/` rule — but it reads policy, so it is
   * not floor-tier either ([/decisions/ad-115.md](/decisions/ad-115.md)).
   */
  const commitGuard = await commentGateBeforeCommit(event, ctx);
  if (commitGuard.kind !== "abstain") {
    recordShellDecisionIfShell(event, ctx, commitGuard);
    return commitGuard;
  }

  const editGuard = await commentGateBeforeEdit(event, ctx);
  if (editGuard.kind !== "abstain") {
    return editGuard;
  }

  /**
   * why the full battery only for push/pr-open: that is the moment something leaves the machine —
   * a shared branch, a PR, a deploy. A bare commit does not, so it keeps the cheap check above
   * ([/decisions/ad-116.md](/decisions/ad-116.md)).
   */
  const shipGuard = await shipGateVerdict(event, ctx);
  if (shipGuard.kind !== "abstain") {
    recordShellDecisionIfShell(event, ctx, shipGuard);
    return shipGuard;
  }

  switch (event.event) {
    case "shell.before":
      return handleShellBefore(event, ctx);
    case "mcp.before":
    case "read.before":
      return { kind: "allow" };
    case "tool.before": {
      const guard = coreFacade.policy.guardPolicySurface({
        projectDir: event.projectDir,
        toolName: event.toolName,
        filePath: filePathOf(event),
      });
      if (guard.kind !== "allow") {
        return guard;
      }
      return handleToolBefore(event, ctx);
    }
    default:
      return { kind: "allow" };
  }
};

if (import.meta.main) {
  await main(toolBeforeHandler);
}
