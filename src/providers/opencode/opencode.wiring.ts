import { join } from "node:path";
import type { ProviderWiring, RuntimePaths, WiringEntry } from "../../contracts/index.ts";
import { opencodeConfigDir } from "../../platform/paths.ts";
import type { ProviderWiringKind } from "../provider.port.ts";

export const OPENCODE_LEGACY_PROVIDER = "opencode-legacy";
export const OPENCODE_NAMESPACED_PROVIDER = "opencode-namespaced";

/**
 * The line that says a file at the target is ours.
 *
 * invariant: absence means a human wrote it, and the writer refuses to overwrite without `--force`. The same test
 * decides "is this ours to replace" for both generations, so a hand-copied bridge is never silently clobbered.
 */
export const OPENCODE_MANAGED_MARKER = "@tlc-harness managed";

/** invariant: the `pluginApi` values the two detectors are mutually exclusive on (`opencode.detect.ts`). */
const OPENCODE_LEGACY_API = "legacy";
const OPENCODE_NAMESPACED_API = "namespaced";

type EntrySpec = { hookEvent: string; handler: string; timeoutSeconds: number };

/** why only two: the legacy plugin reference documents payload shapes for these hooks and no others. */
const LEGACY_ENTRY_SPECS: readonly EntrySpec[] = [
  { hookEvent: "tool.execute.before", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "tool.execute.after", handler: "tool-after", timeoutSeconds: 10 },
];

/**
 * why two more: `shell.create.before` and `permission.evaluate` are the interception points that earn the
 * namespaced generation its own capability descriptor ([/decisions/ad-124.md](/decisions/ad-124.md)). Registering
 * them on the legacy bridge would register hooks that API does not have.
 */
const NAMESPACED_ENTRY_SPECS: readonly EntrySpec[] = [
  ...LEGACY_ENTRY_SPECS,
  { hookEvent: "shell.create.before", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "permission.evaluate", handler: "tool-before", timeoutSeconds: 10 },
];

function entriesFor(specs: readonly EntrySpec[], runtime: RuntimePaths, provider: string): WiringEntry[] {
  return specs.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command: "node",
    // why `--provider` and not detection: the launcher's hint channel routes the payload to this exact adapter
    // before any detector runs, which is what keeps two registered opencode adapters from racing.
    args: [runtime.launcherPath, "--provider", provider, spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
  }));
}

/**
 * The one file both generations are written to.
 *
 * hazard: opencode discovers plugins with the glob `{plugin,plugins}/*.{ts,js}`, read out of the 1.18.29 binary.
 * It is flat — one level, `*` and not `**` — so nothing nested under `plugins/` is ever loaded, which is what the
 * previous namespaced target was. Flattening it into a second sibling file would instead have opencode load two
 * auto-discovered bridges and fire every hook twice. One file, adapting at load time, is neither
 * ([/decisions/ad-124.md](/decisions/ad-124.md)).
 *
 * why `.js` and not `.mjs`: the glob accepts `.ts` and `.js` and nothing else.
 */
function opencodeBridgeTarget(): string {
  return join(opencodeConfigDir(), "plugins", "tlc-harness.js");
}

export function opencodeLegacyWiring(runtime: RuntimePaths): ProviderWiring<ProviderWiringKind> {
  return {
    target: opencodeBridgeTarget(),
    kind: "opencode-plugin",
    strategy: "replace",
    entries: entriesFor(LEGACY_ENTRY_SPECS, runtime, OPENCODE_LEGACY_PROVIDER),
  };
}

export function opencodeNamespacedWiring(runtime: RuntimePaths): ProviderWiring<ProviderWiringKind> {
  return {
    target: opencodeBridgeTarget(),
    kind: "opencode-plugin-ns",
    strategy: "replace",
    entries: entriesFor(NAMESPACED_ENTRY_SPECS, runtime, OPENCODE_NAMESPACED_PROVIDER),
  };
}

/**
 * invariant: the emitted text must be byte-identical whichever generation's wiring rendered it, because both name
 * the same target and the second write would otherwise rewrite the first. So the tables below are built from the
 * generation specs, never from the wiring's own entries — the wiring supplies the launcher path and nothing else.
 */
function handlerMap(): string {
  const rows = NAMESPACED_ENTRY_SPECS.map(
    (spec) => `  ${JSON.stringify(spec.hookEvent)}: ${JSON.stringify(spec.handler)}`,
  );
  return `{\n${rows.join(",\n")},\n}`;
}

/**
 * why one launcher argv per generation rather than one for the file: the `--provider` hint is what routes a
 * payload to one of two adapters that both answer to `provider: "opencode"`. A single bridge that served both
 * generations under one hint would hand every payload to the wrong adapter half the time.
 */
function launcherTable(entries: readonly WiringEntry[]): string {
  const first = entries[0];
  if (first === undefined) {
    return "{}";
  }
  // invariant: every entry shares one command and one launcher path; only the hint and the handler differ.
  const launcherPath = first.args[0];
  const rows = [
    [OPENCODE_LEGACY_API, OPENCODE_LEGACY_PROVIDER],
    [OPENCODE_NAMESPACED_API, OPENCODE_NAMESPACED_PROVIDER],
  ].map(
    ([api, provider]) =>
      `  ${JSON.stringify(api)}: ${JSON.stringify([first.command, launcherPath, "--provider", provider])}`,
  );
  return `{\n${rows.join(",\n")},\n}`;
}

function timeoutMs(): number {
  return Math.max(1, ...NAMESPACED_ENTRY_SPECS.map((spec) => spec.timeoutSeconds)) * 1000;
}

/**
 * why one module for two generations: opencode auto-discovers every sibling in the plugins directory and loads
 * them all, so a second bridge would fire every hook twice.
 *
 * why it is generated rather than shipped as a file the plugin imports: opencode loads this module from its own
 * plugins directory, which is not inside this package. A relative import would break the moment the runtime moved,
 * and that is the failure `TLC_HOME` exists to prevent elsewhere.
 *
 * hazard: `@opencode-ai/plugin` 1.17.9 exports only `tool` at runtime — its `dist/index.js` is
 * `export * from "./tool.js"`, and `Plugin` exists solely as a type. An `import { Plugin } from
 * "@opencode-ai/plugin"` is therefore a link-time error that takes the whole module down, so this file imports
 * nothing but `node:child_process`.
 *
 * invariant: the module's only export is a function. opencode's legacy plugin host iterates every export and
 * throws `TypeError("Plugin export is not a function")` on the first one that is neither a function nor an object
 * with a function `server` — a single exported constant would disable the bridge. It dedupes by identity, so a
 * default export is registered exactly once.
 */
function renderOpencodeBridge(wiring: ProviderWiring<ProviderWiringKind>): string {
  return `// ${OPENCODE_MANAGED_MARKER} — generated by \`tlc harness update\`. Edits here are overwritten.
// invariant: one module, both pluginApi generations — ${OPENCODE_LEGACY_API} and ${OPENCODE_NAMESPACED_API}, chosen at load time
import { spawnSync } from "node:child_process";

const LAUNCHER_BY_API = ${launcherTable(wiring.entries)};
const HANDLER_BY_HOOK = ${handlerMap()};
const TIMEOUT_MS = ${timeoutMs()};

function decide(pluginApi, hook, payload) {
  const handler = HANDLER_BY_HOOK[hook];
  const launcher = LAUNCHER_BY_API[pluginApi];
  if (!handler || !launcher) {
    return null;
  }
  const [command, ...prefix] = launcher;
  const result = spawnSync(command, [...prefix, handler], {
    input: JSON.stringify({ provider: "opencode", pluginApi, hook, ...payload }),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  const text = (result.stdout ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    const decision = JSON.parse(text);
    return decision && typeof decision === "object" && typeof decision.kind === "string" ? decision : null;
  } catch {
    // why swallowed: a harness that cannot answer must not be the thing that stops the turn.
    return null;
  }
}

function legacyHooks() {
  return {
    "tool.execute.before": async (input, output) => {
      const decision = decide(${JSON.stringify(OPENCODE_LEGACY_API)}, "tool.execute.before", {
        sessionID: input.sessionID,
        tool: input.tool,
        args: output?.args ?? input.args,
      });
      if (!decision) {
        return;
      }
      // why a throw: the legacy reference documents that throwing from this hook blocks execution. It is the only
      // block channel this generation has.
      if (decision.kind === "deny") {
        throw new Error(decision.reason);
      }
      if (decision.kind === "rewriteInput" && output && output.args) {
        Object.assign(output.args, decision.input);
      }
      if (decision.kind === "context" && output) {
        output.context = [output.context, decision.text].filter(Boolean).join("\\n");
      }
    },
    "tool.execute.after": async (input, output) => {
      decide(${JSON.stringify(OPENCODE_LEGACY_API)}, "tool.execute.after", {
        sessionID: input.sessionID,
        tool: input.tool,
        args: output?.args ?? input.args,
      });
    },
  };
}

async function registerNamespaced(ctx) {
  await ctx.tool.hook("execute.before", (event) => {
    const decision = decide(${JSON.stringify(OPENCODE_NAMESPACED_API)}, "tool.execute.before", {
      sessionID: event.sessionID,
      tool: event.tool,
      args: event.input,
    });
    // hazard: blocking from this hook is documented on the legacy API and not on this one. The documented block
    // channel here is \`permission.evaluate\`'s deny, below; throwing is the fail-safe attempt, not a promise.
    if (decision && decision.kind === "deny") {
      throw new Error(decision.reason);
    }
  });
  await ctx.tool.hook("execute.after", (event) => {
    const decision = decide(${JSON.stringify(OPENCODE_NAMESPACED_API)}, "tool.execute.after", {
      sessionID: event.sessionID,
      tool: event.tool,
      args: event.input,
      status: event.status,
    });
    // why \`event.result\`: it is the one mutable object this generation documents on execute.after, so it is
    // both the output-rewrite channel and the only place context can ride after a tool.
    if (decision && decision.kind === "context" && event.status === "completed") {
      event.result = { ...event.result, tlcHarness: decision.text };
    }
  });
  await ctx.shell.hook("create.before", (event) => {
    const decision = decide(${JSON.stringify(OPENCODE_NAMESPACED_API)}, "shell.create.before", {
      sessionID: event.sessionID,
      command: event.command,
      cwd: event.cwd,
    });
    if (decision && decision.kind === "deny") {
      throw new Error(decision.reason);
    }
  });
  await ctx.permission.hook("evaluate", (event) => {
    const decision = decide(${JSON.stringify(OPENCODE_NAMESPACED_API)}, "permission.evaluate", {
      sessionID: event.sessionID,
      action: event.action,
      resources: event.resources,
    });
    if (!decision) {
      return;
    }
    // why ask is passed through rather than degraded: this hook is the ask channel, and it is the whole reason
    // this generation carries a non-empty \`askSupportedOn\`. Degrading here would convert an escalation the
    // operator would have seen into a silent one.
    if (decision.kind === "ask" || decision.kind === "deny") {
      event.effect = decision.kind;
      event.message = decision.reason;
    }
  });
}

// why a feature test on the plugin input and not a version string: the namespaced generation is distinguishable
// only by the registration surface it hands the plugin. A host that has no \`hook\` to call is the legacy one.
function isNamespacedHost(input) {
  return (
    typeof input?.tool?.hook === "function" &&
    typeof input?.shell?.hook === "function" &&
    typeof input?.permission?.hook === "function"
  );
}

export default async function TlcHarness(input) {
  if (isNamespacedHost(input)) {
    await registerNamespaced(input);
    // why an empty object rather than nothing: the legacy host requires a hooks object back, and returning the
    // flat keys here would register the same hooks twice on a host that already took them through \`ctx\`.
    return {};
  }
  return legacyHooks();
}
`;
}

/**
 * invariant: one target, one text. Both opencode kinds render the same module, so whichever generation's wiring
 * is written second finds the file already correct and reports `unchanged` instead of rewriting it.
 */
export function renderOpencodePlugin(wiring: ProviderWiring<ProviderWiringKind>): string | null {
  if (wiring.kind === "opencode-plugin" || wiring.kind === "opencode-plugin-ns") {
    return renderOpencodeBridge(wiring);
  }
  return null;
}

/** invariant: the same question `applyCursorWiring` asks of a hooks file — is this file ours to replace? */
export function isOpencodeManaged(text: string | null): boolean {
  return text?.includes(OPENCODE_MANAGED_MARKER) ?? false;
}
