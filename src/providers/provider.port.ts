import type {
  Decision,
  HarnessEvent,
  ProviderCapabilities,
  ProviderPolicyDefaults,
  ProviderWiring,
  Rendered,
  RuntimePaths,
} from "../contracts/index.ts";

/**
 * The on-disk formats an adapter can ask the tooling to write.
 *
 * invariant: closed, not `string`. A new member is a compile error in every exhaustive switch over it until that
 * switch handles it, so a host cannot ship a format the tooling silently ignores — the exhaustive reader is
 * `providerWiringStatus` in `tools/doctor.ts`. Members are added by the change that introduces the writer, never
 * ahead of it.
 *
 * why here and not in `src/contracts`: every member is a vendor identifier, and `check-boundaries` keeps those out
 * of core. This is the innermost layer allowed to name a host.
 */
export type ProviderWiringKind =
  | "claude-settings-json"
  | "cursor-hooks-json"
  | "opencode-plugin"
  | "opencode-plugin-ns"
  | "codex-hooks-json";

/** Core never imports this type — it receives a HarnessEvent and ProviderCapabilities as plain arguments instead. */
export type ProviderPort = {
  readonly name: string;
  detect(raw: unknown): boolean;
  capabilities(): ProviderCapabilities;
  policyDefaults(): ProviderPolicyDefaults;
  toEvent(raw: Record<string, unknown>): HarnessEvent | null;
  render(decision: Decision, event: HarnessEvent): Rendered;
  wiring(runtime: RuntimePaths): ProviderWiring<ProviderWiringKind>;
};
