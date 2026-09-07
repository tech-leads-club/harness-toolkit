import type { ProviderPort } from "../provider.port.ts";
import { cursorCapabilities } from "./cursor.capabilities.ts";
import { detectCursor } from "./cursor.detect.ts";
import { cursorToEvent } from "./cursor.inbound.ts";
import { cursorRender } from "./cursor.outbound.ts";
import { cursorPolicyDefaults } from "./cursor.policy-defaults.ts";
import { cursorWiring, cursorWiringTargets } from "./cursor.wiring.ts";

export const cursorProvider: ProviderPort = {
  name: "cursor",
  detect: detectCursor,
  capabilities: cursorCapabilities,
  policyDefaults: cursorPolicyDefaults,
  toEvent: cursorToEvent,
  render: cursorRender,
  wiring: cursorWiring,
  wiringTargets: cursorWiringTargets,
};
