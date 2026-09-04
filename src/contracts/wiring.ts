export type RuntimePaths = {
  launcherPath: string;
};

export type WiringEntry = {
  hookEvent: string;
  handler: string;
  command: string;
  args: string[];
  timeoutSeconds: number;
  failClosed?: boolean;
  matcher?: string;
  loopLimit?: number;
};

/**
 * `Kind` names the on-disk format of `target`, so a dispatcher can pick a writer without asking which host the
 * wiring came from.
 *
 * why a parameter and not a union declared here: the set of formats is a fact about the hosts, and every member of
 * it is a vendor identifier. `check-boundaries` forbids those in `src/contracts` precisely so this file cannot
 * grow a list of the hosts core is supposed to know nothing about. The closed union lives one layer out, in
 * `src/providers/provider.port.ts`, and the port narrows this parameter to it — so the union is still closed where
 * adapters and tooling meet, and core still cannot name a host.
 *
 * why the field exists at all: `strategy` answers replace-or-merge, which is not the same question as which writer
 * to call. Two formats can share a strategy and still be different documents — a flat hooks JSON and an ES-module
 * plugin are both replaced wholesale. Without the discriminator the dispatchers have to recover the format from
 * the provider's name, which is the one thing `ProviderPort` exists to keep out of the tooling.
 */
export type ProviderWiring<Kind extends string = string> = {
  target: string;
  kind: Kind;
  strategy: "replace" | "merge";
  entries: WiringEntry[];
};
