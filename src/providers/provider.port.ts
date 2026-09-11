import type {
  Decision,
  HarnessEvent,
  ProviderCapabilities,
  ProviderPolicyDefaults,
  ProviderWiring,
  Rendered,
  RuntimePaths,
} from "../contracts/index.ts";

/** Core never imports this type — it receives a HarnessEvent and ProviderCapabilities as plain arguments instead. */
export type ProviderPort = {
  readonly name: string;
  detect(raw: unknown): boolean;
  capabilities(): ProviderCapabilities;
  policyDefaults(): ProviderPolicyDefaults;
  toEvent(raw: Record<string, unknown>): HarnessEvent | null;
  render(decision: Decision, event: HarnessEvent): Rendered;
  wiring(runtime: RuntimePaths): ProviderWiring;
  wiringTargets(): string[];
};
