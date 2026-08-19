import type { HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import { currentGitSha, obsConfigFor } from "./support.ts";

export const promptSubmitHandler: Handler = async (event: HarnessEvent, ctx: HandlerContext) => {
  coreFacade.observability.recordFromEvent(event.projectDir, obsConfigFor(ctx.policy), event);
  // why: the prompt is the turn boundary, so this is where the once-per-turn framing marker resets.
  coreFacade.untrusted.clearFramingMarker(event.projectDir, event.sessionKey);
  coreFacade.untrusted.clearRecall(event.projectDir, event.sessionKey);
  // why: every stop-time gate diffs against this, not against HEAD. A turn that commits moves HEAD past its
  // own changes, and each gate then read an empty diff and skipped ([/decisions/ad-058.md](/decisions/ad-058.md)).
  const sha = await currentGitSha(event.projectDir);
  if (sha) {
    await coreFacade.handoff.patchHandoff(event.projectDir, event.provider, {
      slice: { turn_base_sha: sha },
    });
  }
  return { kind: "abstain" };
};

if (import.meta.main) {
  await main(promptSubmitHandler);
}
