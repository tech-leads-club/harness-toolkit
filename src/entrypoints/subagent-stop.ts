import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import { observeForRules } from "./support.ts";

// why: no legacy predecessor covers subagent.stop verification — this reuses the same unfinished-work
// signal (blockers/pending/in_progress/previous_gaps) already carried on the handoff slice.
export const subagentStopHandler: Handler = async (
  event: HarnessEvent,
  ctx: HandlerContext,
): Promise<Decision> => {
  // why before the verdict: this records that a subagent of this type finished, which is the proof an operator
  // rule asks for. It cannot change the decision below ([/decisions/ad-100.md](/decisions/ad-100.md)).
  await observeForRules(event, ctx);

  const handoff = coreFacade.handoff.readHandoff(event.projectDir, event.provider);
  // why: `blockers` is per-project, and every Task subagent shares the parent's session_id
  // (anthropics/claude-code#7881), so this cannot tell its own subagent apart from another. A "budget"
  // category means the session's turn budget ran out, not that the tree is broken — unlike a gate
  // failure, it is not valid evidence here ([/decisions/ad-073.md](/decisions/ad-073.md)).
  const isBudgetBlocker = handoff.last_failure_category === "budget";
  const unfinishedWork =
    (Boolean(handoff.blockers) && !isBudgetBlocker) ||
    Boolean(handoff.previous_gaps?.length) ||
    Boolean(handoff.pending?.length) ||
    Boolean(handoff.in_progress?.length);

  if (!unfinishedWork) {
    return { kind: "abstain" };
  }

  return {
    kind: "continue",
    text: [
      "BLOCKED: unfinished work remains before this subagent stops.",
      `TRIED: subagent (${event.spawnSubagentType ?? "unknown"}) reported stop.`,
      `NEED: ${handoff.next_action ?? "resolve the open blockers before ending this subagent turn."}`,
    ].join("\n"),
  };
};

if (import.meta.main) {
  await main(subagentStopHandler);
}
