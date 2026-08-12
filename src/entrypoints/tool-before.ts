import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import {
  effectiveAllowedModels,
  effectiveBlockedPatterns,
  effectiveMinEffort,
  obsConfigFor,
  readModelFromToolInput,
} from "./support.ts";

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
    },
  });
}

function recordShellDecisionIfShell(event: HarnessEvent, ctx: HandlerContext, decision: Decision): void {
  if (event.event === "shell.before") {
    recordShellDecision(event, ctx, decision);
  }
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
    const spawnDecision = coreFacade.subagentPolicy.evaluateSubagentSpawn({
      provider: provider.name,
      sessionKey: event.sessionKey,
      projectDir: event.projectDir,
      model,
      effort: event.effort,
      allowedModels: effectiveAllowedModels(policy.subagents.allowedModels, provider),
      blockedPatterns: effectiveBlockedPatterns(policy.subagents.blockedPatterns, provider),
      minEffort: effectiveMinEffort(policy.subagents.minEffort, provider),
      requireModel: policy.subagents.requireModel,
      enforceAllowlist: policy.subagents.enforceAllowlist,
      blockParentFast: policy.subagents.blockParentFast,
      blockMode: policy.subagents.blockMode,
    });
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

export const toolBeforeHandler: Handler = (
  event: HarnessEvent,
  ctx: HandlerContext,
): Decision | Promise<Decision> => {
  // invariant: the floor runs first and reads no policy, so no config value and no agent edit can
  // reach a decision before it.
  const floor = coreFacade.floor.evaluateFloor({
    projectDir: event.projectDir,
    toolName: event.toolName,
    filePath: filePathOf(event),
    command: event.command,
    isReadEvent: event.event === "read.before",
  });
  if (floor.kind !== "allow") {
    // invariant: one rail owns the record of every shell decision. The floor short-circuits before the shell
    // rail runs, so without this a floor denial of a shell command was recorded by nothing at all — and the
    // shared refusal path deliberately skips `shell.before` to avoid double-counting what this rail owns.
    recordShellDecisionIfShell(event, ctx, floor);
    return floor;
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
