import type { ProviderPort } from "../provider.port.ts";
import { vscodeCapabilities } from "./vscode.capabilities.ts";
import { detectVSCode, VSCODE_PROVIDER } from "./vscode.detect.ts";
import { vscodeToEvent } from "./vscode.inbound.ts";
import { vscodeRender } from "./vscode.outbound.ts";
import { vscodePolicyDefaults } from "./vscode.policy-defaults.ts";
import { vscodeWiring } from "./vscode.wiring.ts";

export const vscodeProvider: ProviderPort = {
  name: VSCODE_PROVIDER,
  detect: detectVSCode,
  capabilities: vscodeCapabilities,
  policyDefaults: vscodePolicyDefaults,
  toEvent: vscodeToEvent,
  render: vscodeRender,
  wiring: vscodeWiring,
};
