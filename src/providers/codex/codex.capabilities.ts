import type { ProviderCapabilities } from "../../contracts/index.ts";

export function codexCapabilities(): ProviderCapabilities {
  return {
    enforcesHooks: true,
    askSupportedOn: [],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: true,
    toolOutputRewriteOn: [],
    contextAtToolBefore: true,
    contextAtToolAfter: true,
    contextAtStop: false,
    sessionStartContextReliable: true,
    toolOutputAtAfter: true,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  };
}
