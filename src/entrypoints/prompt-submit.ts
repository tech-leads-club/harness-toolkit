import type { HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import { currentGitSha, obsConfigFor, shaScopeRoot } from "./support.ts";

export const promptSubmitHandler: Handler = async (event: HarnessEvent, ctx: HandlerContext) => {
  coreFacade.observability.recordFromEvent(event.projectDir, obsConfigFor(ctx.policy), event);
  // why: the prompt is the turn boundary, so this is where the once-per-turn framing marker resets.
  coreFacade.untrusted.clearFramingMarker(event.projectDir, event.sessionKey);
  coreFacade.untrusted.clearRecall(event.projectDir, event.sessionKey);
  // why: every stop-time gate diffs against this, not against HEAD. A turn that commits moves HEAD past its
  // own changes, and each gate then read an empty diff and skipped ([/decisions/ad-058.md](/decisions/ad-058.md)).
  // why: the exact AD-114 divergence, now against turn_base_sha instead of a rule's proof sha — a worktree
  // session recorded the main checkout's HEAD as the turn's start, so every gate diffing against it saw a
  // whole untouched file read as "added this turn" ([/decisions/ad-117.md](/decisions/ad-117.md)).
  const sha = await currentGitSha(shaScopeRoot(event));
  if (sha) {
    await coreFacade.handoff.patchHandoff(event.projectDir, event.provider, event.sessionKey, {
      slice: { turn_base_sha: sha },
    });
  }
  return { kind: "abstain" };
};

if (import.meta.main) {
  await main(promptSubmitHandler);
}
