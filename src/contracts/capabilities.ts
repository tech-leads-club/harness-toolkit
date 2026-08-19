import type { HarnessEventKind } from "./harness-event.ts";

export type ProviderCapabilities = {
  enforcesHooks: boolean;
  askSupportedOn: HarnessEventKind[];
  sessionEnv: boolean;
  nativeLoopCounter: boolean;
  dedicatedShellEvent: boolean;
  toolInputRewrite: boolean;
  toolOutputRewrite: boolean;
  contextAtToolBefore: boolean;
  contextAtToolAfter: boolean;
  contextAtStop: boolean;
  /**
   * Whether context returned from the session-start hook reaches the model. A host can accept the field, log it as
   * merged, and still drop it, so this is not the same question as whether the field exists. A host declaring false
   * needs the durable provider view to carry lessons; the adapter that declares it cites the evidence
   * ([/decisions/ad-050.md](/decisions/ad-050.md)).
   */
  sessionStartContextReliable: boolean;
  /**
   * Whether an after-event delivers what the tool returned. Measured as per-event rather than per-host: one host
   * supplies it on its shell and MCP after-events and not on its generic tool after-event, so a rail that needs
   * it asks the capability and then still checks the field ([/decisions/ad-077.md](/decisions/ad-077.md)).
   */
  toolOutputAtAfter: boolean;
  usageInPayload: boolean;
  effortSignal: boolean;
  thoughtEvent: boolean;
};
