import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EffortLevel, HarnessEvent } from "../contracts/index.ts";
import { coreFacade, type HarnessLesson, type ObservabilityConfig, type Policy } from "../core/index.ts";
import { runProcess } from "../platform/process.ts";
import { type ProviderPort, renderClaudeLessonsView, renderCursorLessonsView } from "../providers/index.ts";

// invariant: one definition, taken from core rather than restated.
export const OBS_CONFIG = coreFacade.observability.DEFAULT_OBS;

// why: tool.end, shell.end, mcp.end and file.edit are debug-level kinds, so the passive audit trail only
// persists when debug writing is on. The difference from OBS_CONFIG is stated here once instead of being
// re-declared per entrypoint.
export const OBS_CONFIG_AUDIT = { ...OBS_CONFIG, debugEnabled: true };

// why: the base configs are module constants, so the one operator-controlled field has to be layered on
// per call rather than baked in at import time.
export function obsConfigFor(
  policy: { obs: Policy["obs"] },
  base: ObservabilityConfig = OBS_CONFIG,
): ObservabilityConfig {
  return {
    ...base,
    globalSpool: policy.obs.globalSpool,
    // why: debugEnabled is deliberately absent from Policy.obs. The only events that resolve to debug level
    // are emitted with OBS_CONFIG_AUDIT, which forces it on for the audit trail (AD-016 item 7), so there is
    // nothing a project could switch. Exposing it would repeat the dead-section mistake this replaces.
    includePayloads: policy.obs.includePayloads,
    maxAttrChars: policy.obs.maxAttrChars,
    sessionCostAlertUsd: policy.obs.sessionCostAlertUsd,
    retentionDays: policy.obs.retentionDays,
  };
}

/** Characters on disk, or zero when the file went away between the write and the read. */
export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function sessionIdFromKey(event: HarnessEvent): string {
  const prefix = `${event.provider}-`;
  return event.sessionKey.startsWith(prefix) ? event.sessionKey.slice(prefix.length) : event.sessionKey;
}

export async function currentGitBranch(root: string): Promise<string | null> {
  if (!existsSync(join(root, ".git"))) {
    return null;
  }
  const result = await runProcess({ command: ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd: root });
  if (result.exitCode !== 0) {
    return null;
  }
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

/**
 * why: `event.projectDir` prefers `CLAUDE_PROJECT_DIR`, which the host deliberately keeps pointed at the
 * session's original root — including inside a git worktree, where it would otherwise return the wrong
 * HEAD for a `since HEAD` rule proof. `event.cwd` is the field the host actually moves when the agent is
 * working in a worktree or after a `cd`. Only the rules engine's proof sha needs this; every other use of
 * `event.projectDir` (state dir, policy config, presence) is deliberately left alone
 * ([/decisions/ad-114.md](/decisions/ad-114.md)).
 */
export function shaScopeRoot(event: HarnessEvent): string {
  return event.cwd ?? event.projectDir;
}

export async function currentGitSha(root: string): Promise<string | null> {
  if (!existsSync(join(root, ".git"))) {
    return null;
  }
  const result = await runProcess({ command: ["git", "rev-parse", "--short", "HEAD"], cwd: root });
  if (result.exitCode !== 0) {
    return null;
  }
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * hazard: this fell back to a shipped list whenever the project's was empty, so a spawn could be refused by an
 * allowlist that exists nowhere in the project — and the refusal named no source, so an operator reading `[]` in
 * their own config could only conclude that empty meant none. There is no shipped list now: the effective one is
 * exactly what the project configured ([/decisions/ad-053.md](/decisions/ad-053.md)).
 */
export function effectiveAllowedModels(
  configured: string[] | Record<string, string[]> | undefined,
  provider: ProviderPort,
): string[] {
  return coreFacade.policy.forProvider(configured, provider.name) ?? [];
}

export function effectiveBlockedPatterns(
  configured: string[] | Record<string, string[]> | undefined,
  provider: ProviderPort,
): string[] {
  const fromConfig = coreFacade.policy.forProvider(configured, provider.name) ?? [];
  return [...fromConfig, ...provider.policyDefaults().blockedPatterns];
}

export function effectiveMinEffort(
  configured: EffortLevel | null,
  provider: ProviderPort,
): EffortLevel | null {
  return configured ?? provider.policyDefaults().minEffort;
}

/**
 * Everything `evaluateSubagentSpawn` needs about a spawn, assembled once.
 *
 * hazard: `subagent-start` and `tool-before` each built this object, seven identical lines apart from the
 * indentation, so a new field in `policy.subagents` had to be remembered in two places — the shape where a
 * consumer stops growing with its producer ([/decisions/ad-065.md](/decisions/ad-065.md)). The duplication rail
 * found it on its first honest run ([/decisions/ad-071.md](/decisions/ad-071.md)).
 */
export function subagentSpawnInput(
  event: HarnessEvent,
  policy: Policy,
  provider: ProviderPort,
  model: string,
): Parameters<typeof coreFacade.subagentPolicy.evaluateSubagentSpawn>[0] {
  return {
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
  };
}

export function readModelFromToolInput(toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) {
    return "";
  }
  const model = toolInput.model ?? toolInput.Model;
  return typeof model === "string" ? model : "";
}

/**
 * hazard: this used to be a copy of the core renderer, on the reasoning that presentation is not core's business.
 * The copy is what the model actually receives, so the tier added to the core block rendered in `lessons list` and
 * in nothing an agent ever saw. Two renderers for one string is the same defect as a consumer without a producer,
 * pointed sideways ([/decisions/ad-040.md](/decisions/ad-040.md)).
 */
export function renderLessonLine(lesson: HarnessLesson): string {
  return coreFacade.lesson.renderLessonBlock(lesson);
}

/**
 * invariant: one dispatcher, imported by both session entrypoints. The durable view is written at session start and
 * again at session end, and a copy of this switch in each would be the AD-042 defect a second time.
 */
export function renderProviderLessonsView(providerName: string, root: string): string | null {
  if (providerName === "cursor") {
    return renderCursorLessonsView(root);
  }
  if (providerName === "claude") {
    return renderClaudeLessonsView(root);
  }
  return null;
}

/**
 * why: `omitted` is rendered because the char budget silently cuts below `maxInjectSession` — the count promises
 * five and a 900-char budget fits about two. A reader who cannot tell that eligible lessons were dropped has no
 * way to know the budget is the binding constraint ([/decisions/ad-043.md](/decisions/ad-043.md)).
 *
 * invariant: silent when nothing was dropped. A note on every healthy turn is one more line to skim past.
 */
export function formatLessonsBlock(lessons: HarnessLesson[], title: string, omitted = 0): string {
  if (lessons.length === 0) {
    return "";
  }
  const lines = [title, ...lessons.map(renderLessonLine)];
  if (omitted > 0) {
    const noun = omitted === 1 ? "lesson" : "lessons";
    lines.push(
      `  (${omitted} more eligible ${noun} omitted under the char budget — raise maxCharsSession to see them)`,
    );
  }
  return lines.join("\n");
}

/**
 * The producer half of the feature: what the harness witnessed, written where only the harness can write it.
 *
 * hazard: this did not exist in the first cut. `observe` had no caller, so the store was never written, no proof
 * could ever be satisfied, and every rule that parsed denied for ever — `require:` is mandatory, so that was
 * every rule ([/decisions/ad-100.md](/decisions/ad-100.md)).
 *
 * why `wants` first: this runs on every tool call and the sha is a process spawn. Nothing is asked of git unless
 * a declared rule requires this kind of proof, so an operator whose only rule wants a subagent pays no git on any
 * command.
 *
 * invariant: after the event, never able to change it. A rail that records what happened must not become a rail
 * that decides whether it may.
 */
export async function observeForRules(
  event: HarnessEvent,
  // why the shape and not `HandlerContext`: `run.ts` already imports this module, so naming its type here would
  // close an import cycle. Only the one field is needed.
  ctx: { policy: { rules: Policy["rules"] } },
): Promise<void> {
  const config = ctx.policy.rules;
  if (!coreFacade.rules.wants(event.projectDir, config, event)) {
    return;
  }
  const sha = await currentGitSha(shaScopeRoot(event));
  coreFacade.rules.observe(event.projectDir, config, event, {
    sha,
    sessionKey: event.sessionKey,
    at: new Date().toISOString(),
  });
}
