import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";

export const responseAfterHandler: Handler = async (
  event: HarnessEvent,
  ctx: HandlerContext,
): Promise<Decision> => {
  const text = event.text ?? "";

  if (ctx.policy.planGate.enabled) {
    const plan = coreFacade.plan.detectPlan(text);
    const deviations = coreFacade.plan.detectDeviations(text);
    if (plan) {
      await coreFacade.handoff.patchHandoff(event.projectDir, event.provider, event.sessionKey, {
        slice: {
          plan_paths: plan.paths,
          plan_at: ctx.now.toISOString(),
          plan_snippet: plan.snippet,
          plan_deviations: [],
        },
      });
    }
    if (deviations.length > 0) {
      // why: a deviation can be justified in a later message than the one that declared the plan, so they
      // accumulate for the plan's window instead of replacing what was already accepted.
      const handoff = coreFacade.handoff.readHandoff(event.projectDir, event.provider, event.sessionKey);
      const known = handoff.plan_deviations ?? [];
      const fresh = deviations.filter((deviation) => !known.some((seen) => seen.path === deviation.path));
      if (fresh.length > 0) {
        await coreFacade.handoff.patchHandoff(event.projectDir, event.provider, event.sessionKey, {
          slice: { plan_deviations: [...known, ...fresh] },
        });
      }
    }
  }

  const claim = coreFacade.ship.detectShipClaim(text);
  if (claim) {
    await coreFacade.handoff.patchHandoff(event.projectDir, event.provider, event.sessionKey, {
      slice: {
        last_ship_claim_at: ctx.now.toISOString(),
        last_ship_claim_snippet: claim.snippet,
        last_ship_claim_kind: claim.kind,
      },
    });
    coreFacade.ship.appendShipLedger(event.projectDir, {
      provider: event.provider,
      event: "claim",
      claimKind: claim.kind,
      detail: claim.snippet,
    });
  }
  return { kind: "abstain" };
};

if (import.meta.main) {
  await main(responseAfterHandler);
}
