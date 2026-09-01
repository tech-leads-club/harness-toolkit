import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import { renderProviderLessonsView, sessionIdFromKey } from "./support.ts";

export const sessionEndHandler: Handler = async (
  event: HarnessEvent,
  ctx: HandlerContext,
): Promise<Decision> => {
  const { policy } = ctx;
  const root = event.projectDir;
  const session = sessionIdFromKey(event);

  await coreFacade.handoff.patchHandoff(root, event.provider, event.sessionKey, {
    slice: {
      next_action: "Session ended. Run `tlc harness handoff` before resuming.",
    },
  });

  coreFacade.presence.release(root, event.provider, session);
  coreFacade.turn.resetLoop(root, event.sessionKey);

  if (policy.intelligence.lessons.enabled && policy.intelligence.lessons.gardenOnSessionEnd) {
    const verdict = coreFacade.lesson.durableViewVerdict(
      policy.intelligence.lessons.syncRulesFile,
      ctx.capabilities.sessionStartContextReliable,
    );
    const garden = await coreFacade.lesson.gardenAndPersistLessons(root, policy.intelligence.lessons, {
      writeDurableView: verdict.writes,
    });
    if (garden.markdownPath) {
      renderProviderLessonsView(event.provider, root);
    }
  }

  // why: written at session end, when the rollup is complete. Every field is something the harness observed —
  // there is no claim that the code is correct or that a human approved anything, because it cannot see either and
  // an attestation implying them would be worse than none ([/decisions/ad-028.md](/decisions/ad-028.md)).
  const rollup = coreFacade.observability.getRollup(root, event.sessionKey);
  const sources = coreFacade.policy.policySourceFingerprint(root);
  coreFacade.attest.appendAttestation(root, {
    ts: new Date().toISOString(),
    provider: event.provider,
    session,
    policyFingerprint: coreFacade.attest.fingerprintOf(sources),
    policyDiverged: coreFacade.policy.checkPolicyBaseline(root, event.sessionKey).kind !== "allow",
    railsActive: coreFacade.policy.activeRails(policy),
    decisionsByRule: rollup?.railsByRule ?? {},
    gates: rollup?.gates ?? { pass: 0, fail: 0 },
  });

  return { kind: "abstain" };
};

if (import.meta.main) {
  await main(sessionEndHandler);
}
