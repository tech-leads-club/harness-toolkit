import type { HarnessEventKind } from "../../contracts/harness-event.ts";

/**
 * What a capability does at the moment it triggers, in the operator's terms rather than the code's. `deny` and
 * `ask` answer the tool call; `block-stop` and `follow-up` both send the turn back to work and differ in whether
 * the turn may end; `context` and `record` change no decision at all.
 */
export type CapabilityVerdict = "deny" | "ask" | "block-stop" | "follow-up" | "context" | "record";

export const SUMMARY_MAX_CHARS = 120;

export type CatalogCapability = {
  id: string;
  configPath: string;
  title: string;
  /**
   * One line stating what this rail checks, short enough to sit in a table cell next to twenty others. Capped at
   * `SUMMARY_MAX_CHARS`: a rail that cannot be stated in a line is one the reader cannot scan past, and the
   * unbounded `benefit` field is where the full case belongs.
   */
  summary: string;
  benefit: string;
  tradeOff: string;
  defaultOn: boolean;
  sinceCatalogVersion: number;
  /**
   * The events whose handler evaluates this capability. Required, and checked against `HARNESS_EVENT_KINDS`
   * — the question "when does this fire?" was the one the README could not answer, and a free-text answer is
   * one refactor away from naming an event that no longer exists.
   */
  fires: HarnessEventKind[];
  /** What happens when it triggers. */
  verdict: CapabilityVerdict;
  /**
   * The command or file that shows this capability's own record. Required, because a rail nobody can observe
   * cannot be explained, and one with no producer would have nothing to name here.
   */
  inspect: string;
  /** Follow-up values the wizard collects when the operator accepts. Presentation only. */
  asks?: string[];
  /** A stated recommendation, where there is one worth stating. */
  recommend?: "on" | "off";
};

export type CapabilityCatalog = {
  catalogVersion: number;
  capabilities: CatalogCapability[];
};

export type RuntimeSeen = {
  catalogVersion: number;
  updatedAt?: string;
};

export const ENABLE_HINT =
  'Enable: ask the agent "setup harness" (harness-init skill) or edit .tlc/harness/config.json';
