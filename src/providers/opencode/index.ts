import type { ProviderPort } from "../provider.port.ts";
import { opencodeLegacyCapabilities, opencodeNamespacedCapabilities } from "./opencode.capabilities.ts";
import { detectOpencodeLegacy, detectOpencodeNamespaced } from "./opencode.detect.ts";
import { opencodeToEvent } from "./opencode.inbound.ts";
import { opencodeRender } from "./opencode.outbound.ts";
import { opencodePolicyDefaults } from "./opencode.policy-defaults.ts";
import {
  OPENCODE_LEGACY_PROVIDER,
  OPENCODE_NAMESPACED_PROVIDER,
  opencodeLegacyWiring,
  opencodeNamespacedWiring,
} from "./opencode.wiring.ts";

/**
 * why two ports and not one: the two plugin API generations differ in what the harness can do — an ask channel
 * and a shell interception the legacy API does not have — and `capabilities()` takes no arguments, so one port
 * would have to lie in one direction or the other ([/decisions/ad-124.md](/decisions/ad-124.md)). The inbound
 * parser, the renderer, and the policy defaults are shared; the descriptor, the wiring, and the emitted bridge
 * are not.
 */
export const opencodeLegacyProvider: ProviderPort = {
  name: OPENCODE_LEGACY_PROVIDER,
  detect: detectOpencodeLegacy,
  capabilities: opencodeLegacyCapabilities,
  policyDefaults: opencodePolicyDefaults,
  toEvent: opencodeToEvent,
  render: opencodeRender,
  wiring: opencodeLegacyWiring,
};

export const opencodeNamespacedProvider: ProviderPort = {
  name: OPENCODE_NAMESPACED_PROVIDER,
  detect: detectOpencodeNamespaced,
  capabilities: opencodeNamespacedCapabilities,
  policyDefaults: opencodePolicyDefaults,
  toEvent: opencodeToEvent,
  render: opencodeRender,
  wiring: opencodeNamespacedWiring,
};
