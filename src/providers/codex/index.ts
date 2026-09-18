import type { ProviderPort } from "../provider.port.ts";
import { codexCapabilities } from "./codex.capabilities.ts";
import { detectCodex } from "./codex.detect.ts";
import { codexToEvent } from "./codex.inbound.ts";
import { renderCodexLessonsView } from "./codex.lessons-view.ts";
import { codexRender } from "./codex.outbound.ts";
import { codexPolicyDefaults } from "./codex.policy-defaults.ts";
import { CODEX_PROVIDER, codexWiring, codexWiringTargets } from "./codex.wiring.ts";

export const codexProvider: ProviderPort = {
  name: CODEX_PROVIDER,
  detect: detectCodex,
  capabilities: codexCapabilities,
  policyDefaults: codexPolicyDefaults,
  toEvent: codexToEvent,
  render: codexRender,
  wiring: codexWiring,
  wiringTargets: codexWiringTargets,
  lessonsView: renderCodexLessonsView,
};
