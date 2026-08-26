import { relative } from "node:path";
import type { Decision, HarnessEvent, HarnessEventKind } from "../contracts/index.ts";
import { coreFacade, type ObsKind } from "../core/index.ts";
import { estimateCostUsd, mapPoolToNeutral } from "../platform/pricing.ts";
import { normalizeSeparators } from "../platform/sanitize.ts";
import { readClaudeUsage } from "../providers/index.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import { OBS_CONFIG_AUDIT, obsConfigFor, observeForRules } from "./support.ts";

const OBS_KIND_BY_EVENT: Partial<Record<HarnessEventKind, ObsKind>> = {
  "tool.after": "tool.end",
  "shell.after": "shell.end",
  "mcp.after": "mcp.end",
  "edit.after": "file.edit",
};

function rawString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}

function rawBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key];
  return typeof value === "boolean" ? value : undefined;
}

function usageGenAi(event: HarnessEvent, ctx: HandlerContext): Record<string, unknown> | undefined {
  if (ctx.capabilities.usageInPayload || !event.transcriptPath) {
    return undefined;
  }
  const usage = readClaudeUsage(event.transcriptPath);
  if (!usage) {
    return undefined;
  }
  const cost = estimateCostUsd(event.provider, event.model, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    cost_usd: cost.costUsd,
    cost_source: cost.source,
    cost_pool: mapPoolToNeutral(cost.pool),
  };
}

/**
 * why: this is cheaper than the stop-time scan and scoped to the file this edit touched, so it can afford
 * to run per edit — unlike duplication, which reads the whole tracked tree and stays stop-only
 * ([/decisions/ad-111.md](/decisions/ad-111.md)). It never blocks; a real violation still blocks at stop.
 */
async function commentEditAdvisory(event: HarnessEvent, ctx: HandlerContext): Promise<Decision | null> {
  const { policy } = ctx;
  if (!policy.comments.enabled || policy.comments.onViolation !== "followup" || !event.filePath) {
    return null;
  }
  const relativePath = normalizeSeparators(relative(event.projectDir, event.filePath));
  if (relativePath.startsWith("..") || !coreFacade.policy.isUnderCodePaths(relativePath, policy.codePaths)) {
    return null;
  }
  const targets = coreFacade.commentPolicy.filterCommentTargets([relativePath]);
  if (targets.length === 0) {
    return null;
  }
  const handoff = coreFacade.handoff.readHandoff(event.projectDir, event.provider);
  const hits = await coreFacade.commentPolicy.scanAddedComments(
    event.projectDir,
    targets,
    policy.comments.mode,
    handoff.turn_base_sha ?? "HEAD",
  );
  if (hits.length === 0) {
    return null;
  }
  return { kind: "context", text: coreFacade.commentPolicy.commentEditAdvisory(hits, policy.comments.mode) };
}

export const toolAfterHandler: Handler = async (event: HarnessEvent, ctx: HandlerContext) => {
  // why here and not at `*.before`: arriving on an after-event is what says the tool ran and did not fail. A
  // failure comes as `tool.failure`, a different event this rail never sees, and the payload carries no exit code
  // in any of the three shapes the two hosts send ([/decisions/ad-100.md](/decisions/ad-100.md)).
  await observeForRules(event, ctx);

  coreFacade.observability.recordAudit(event.projectDir, event.event, event.raw, ctx.policy.obs.globalSpool);

  const kind = OBS_KIND_BY_EVENT[event.event];
  if (kind) {
    const attrs: Record<string, unknown> = {
      tool_name: event.toolName,
      command: event.command,
      file_path: event.filePath,
    };
    if (event.event === "shell.after") {
      attrs.cwd = rawString(event.raw, "cwd");
      attrs.sandbox = rawBoolean(event.raw, "sandbox");
    }

    coreFacade.observability.recordObs(event.projectDir, obsConfigFor(ctx.policy, OBS_CONFIG_AUDIT), {
      provider: event.provider,
      kind,
      sessionKey: event.sessionKey,
      model: event.model,
      attrs,
      gen_ai: usageGenAi(event, ctx),
    });
  }

  // hazard: no degrade path consults contextAtToolAfter — the capability is declared but unread, so a
  // provider that cannot carry context on this event would swallow the framing and leave the rail reporting
  // a protection it never delivered. Abstaining keeps the marker unset, so a later event can still speak.
  if (!ctx.capabilities.contextAtToolAfter) {
    return { kind: "abstain" };
  }

  // why: recorded before the framing is decided, because the framing fires once per turn and the content of every
  // untrusted read still has to be remembered ([/decisions/ad-077.md](/decisions/ad-077.md)).
  if (ctx.provider.capabilities().toolOutputAtAfter) {
    coreFacade.untrusted.rememberUntrustedOutput({
      root: event.projectDir,
      sessionKey: event.sessionKey,
      event: event.event,
      toolName: event.toolName,
      command: event.command,
      toolOutput: event.toolOutput,
      config: ctx.policy.untrustedContent,
      providerTools: ctx.provider.policyDefaults().untrustedTools,
    });
  }

  const untrustedDecision = coreFacade.untrusted.evaluateUntrustedContent({
    root: event.projectDir,
    sessionKey: event.sessionKey,
    event: event.event,
    toolName: event.toolName,
    command: event.command,
    config: ctx.policy.untrustedContent,
    providerTools: ctx.provider.policyDefaults().untrustedTools,
  });
  if (untrustedDecision.kind !== "abstain") {
    return untrustedDecision;
  }

  if (event.event === "edit.after") {
    const advisory = await commentEditAdvisory(event, ctx);
    if (advisory) {
      return advisory;
    }
  }

  return { kind: "abstain" };
};

if (import.meta.main) {
  await main(toolAfterHandler);
}
