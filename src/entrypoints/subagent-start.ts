import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import { subagentSpawnInput } from "./support.ts";

export const subagentStartHandler: Handler = (event: HarnessEvent, ctx: HandlerContext): Decision => {
  const { policy, provider } = ctx;
  return coreFacade.subagentPolicy.evaluateSubagentSpawn(
    subagentSpawnInput(event, policy, provider, event.spawnModel ?? ""),
  );
};

if (import.meta.main) {
  await main(subagentStartHandler);
}
