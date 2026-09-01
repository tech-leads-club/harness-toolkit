import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import { projectStateDir } from "../platform/paths.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import {
  currentGitBranch,
  currentGitSha,
  formatLessonsBlock,
  obsConfigFor,
  renderProviderLessonsView,
  sessionIdFromKey,
  sizeOf,
} from "./support.ts";

export const sessionStartHandler: Handler = async (
  event: HarnessEvent,
  ctx: HandlerContext,
): Promise<Decision> => {
  const { policy } = ctx;
  const session = sessionIdFromKey(event);
  const root = event.projectDir;

  // why: recorded before the already-booted return so a resumed session has a baseline too. The check
  // records lazily when one is missing, so this is robustness rather than correctness.
  coreFacade.policy.recordPolicyBaseline(root, event.sessionKey);

  let durableChars = 0;

  const boot = coreFacade.turn.markBooted(root, event.sessionKey);
  if (boot.alreadyBooted) {
    return { kind: "context", text: "", env: { HARNESS_ACTIVE: "1" } };
  }

  const branch = await currentGitBranch(root);
  const sha = await currentGitSha(root);

  coreFacade.presence.sweepStale(root);
  coreFacade.presence.register(root, {
    provider: event.provider,
    session,
    pid: process.pid,
    branch: branch ?? "unknown",
  });

  coreFacade.handoff.pruneDeadHandoffSessions(root);

  await coreFacade.handoff.patchHandoff(root, event.provider, event.sessionKey, {
    shared: {
      mode: policy.mode,
      project_name: policy.projectName,
      git_branch: branch ?? undefined,
      git_sha: sha ?? undefined,
    },
    slice: {
      // why: names the command, not the file. The path is on the policy surface, so an instruction pointing at it
      // asked for something the floor then refused ([/decisions/ad-047.md](/decisions/ad-047.md)).
      next_action: "Run `tlc harness handoff` if resuming; otherwise start from the user request.",
    },
  });

  /**
   * why: the handoff and the lesson store are the two files the harness reads aloud to the model, so a write it
   * did not make is text placed in front of every later turn. Withholding is the answer, not refusing the turn
   * ([/decisions/ad-078.md](/decisions/ad-078.md)).
   */
  const handoffSeal = coreFacade.handoff.handoffInjectable(root, event.sessionKey);
  const lessonSeal = coreFacade.lesson.projectLessonsInjectable(root);
  const handoff = handoffSeal.ok
    ? coreFacade.handoff.readHandoff(root, event.provider, event.sessionKey)
    : ({} as ReturnType<typeof coreFacade.handoff.readHandoff>);
  const foreign = handoffSeal.ok ? coreFacade.handoff.readForeignSlices(root, event.provider) : [];

  const lines = [
    ...[handoffSeal.note, lessonSeal.note].filter((note): note is string => note !== null),
    ...coreFacade.policy.operatorBootstrapLines(policy, projectStateDir(root)),
    "",
    `Project root: ${root}`,
  ];
  if (policy.projectName) {
    lines.push(`Project: ${policy.projectName}`);
  }
  if (branch) {
    lines.push(`Git branch: ${branch}`);
  }
  if (sha) {
    lines.push(`Git HEAD: ${sha}`);
  }
  if (handoff.blockers) {
    lines.push(`Handoff blocker: ${handoff.blockers}`);
  }
  if (handoff.next_action) {
    lines.push(`Handoff next: ${handoff.next_action}`);
  }
  // why: this is the flag's only reader. It was declared, defaulted on, described in the catalog as carrying gaps
  // into the next bootstrap, and read nowhere — so the gaps `stop` wrote were never read back out.
  if (policy.intelligence.progressiveHandoff) {
    const carried = coreFacade.turn.formatCarriedGaps(handoff.previous_gaps ?? []);
    if (carried) {
      lines.push("", carried);
    }
  }
  for (const slice of foreign) {
    lines.push("", `Foreign slice (${slice.provider}):`);
    if (slice.next_action) {
      lines.push(`  next_action: ${slice.next_action}`);
    }
    if (slice.blockers) {
      lines.push(`  blockers: ${slice.blockers}`);
    }
  }

  if (policy.intelligence.lessons.enabled && lessonSeal.ok) {
    const config = policy.intelligence.lessons;
    const selected = await coreFacade.lesson.selectLessons({
      projectDir: root,
      config,
      mode: "session",
      text: [handoff.blockers, handoff.next_action].filter(Boolean).join(" "),
    });
    const block = formatLessonsBlock(
      selected.lessons,
      "Lessons (ranked; follow these — do not repeat known failures):",
      selected.omitted,
    );
    if (block) {
      lines.push("", block);
    }
    // hazard: the durable view was written only at session end, so on the host that depends on it the file carried
    // the previous session's ranked set and did not exist at all during the first one. Written here it is in place
    // before the first prompt ([/decisions/ad-050.md](/decisions/ad-050.md)).
    if (
      coreFacade.lesson.durableViewVerdict(config.syncRulesFile, ctx.capabilities.sessionStartContextReliable)
        .writes
    ) {
      coreFacade.lesson.renderLessonsMarkdown(root, coreFacade.lesson.allLessons(root), config);
      const viewPath = renderProviderLessonsView(event.provider, root);
      // why: measured from the file that was written, not estimated from the lessons that went into it. The view
      // carries frontmatter the injected block does not ([/decisions/ad-050.md](/decisions/ad-050.md)).
      durableChars = viewPath === null ? 0 : sizeOf(viewPath);
    }
  }

  lines.push(
    policy.grind.enabled
      ? "Grind ON: stop hook runs configured lint/test gates and auto-continues on failure."
      : "Grind OFF (default).",
  );

  const text = lines.join("\n");
  // why: the harness injects prose on every session and had never told the operator what it costs. Rails are not
  // free — they are paid in input tokens, on every turn, forever — and a cost nobody can see is a cost nobody
  // weighs ([/decisions/ad-027.md](/decisions/ad-027.md)).
  coreFacade.observability.recordObs(root, obsConfigFor(policy), {
    provider: event.provider,
    kind: "session.start",
    sessionKey: event.sessionKey,
    attrs: {
      injected_chars: text.length,
      injected_lines: lines.length,
      posture: policy.mode,
      lessons_injected: policy.intelligence.lessons.enabled,
      durable_chars: durableChars,
      hook_context_reliable: ctx.capabilities.sessionStartContextReliable,
    },
  });

  return { kind: "context", text, env: { HARNESS_ACTIVE: "1" } };
};

if (import.meta.main) {
  await main(sessionStartHandler);
}
