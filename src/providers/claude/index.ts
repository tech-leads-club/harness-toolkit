import type { ProviderPort } from "../provider.port.ts";
import { claudeCapabilities } from "./claude.capabilities.ts";
import { detectClaude } from "./claude.detect.ts";
import { claudeToEvent } from "./claude.inbound.ts";
import { claudeRender } from "./claude.outbound.ts";
import { claudePolicyDefaults } from "./claude.policy-defaults.ts";
import { claudeWiring, claudeWiringTargets } from "./claude.wiring.ts";

export const claudeProvider: ProviderPort = {
  name: "claude",
  detect: detectClaude,
  capabilities: claudeCapabilities,
  policyDefaults: claudePolicyDefaults,
  toEvent: claudeToEvent,
  render: claudeRender,
  wiring: claudeWiring,
  wiringTargets: claudeWiringTargets,
};
