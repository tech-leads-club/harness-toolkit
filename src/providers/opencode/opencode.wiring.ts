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

function opencodePluginsDir(): string {
  return join(opencodeConfigDir(), "plugins");
}

export function opencodeLegacyWiring(runtime: RuntimePaths): ProviderWiring<ProviderWiringKind> {
  return {
    // why `.js` and not `.mjs`: the plugin reference documents JavaScript and TypeScript plugin files. `.mjs` is
    // documented nowhere, and this file is loaded by the host, not by us.
    target: join(opencodePluginsDir(), "tlc-harness.js"),
    kind: "opencode-plugin",
    strategy: "replace",
    entries: entriesFor(LEGACY_ENTRY_SPECS, runtime, OPENCODE_LEGACY_PROVIDER),
  };
}

/**
 * hazard: the namespaced entry point is documented as `.opencode/plugins/<id>/index.ts` for a *project*. No
 * global location is documented for this generation at all. This writer uses the global plugins directory the
 * legacy reference documents, because `wiring()` is handed a launcher path and no project root — every other host
 * here is wired user-level for the same reason. If v2 turns out to read only project-local plugins, this target
 * is the one line to change ([/decisions/ad-124.md](/decisions/ad-124.md)).
 */
export function opencodeNamespacedWiring(runtime: RuntimePaths): ProviderWiring<ProviderWiringKind> {
  return {
    target: join(opencodePluginsDir(), "tlc-harness", "index.ts"),
    kind: "opencode-plugin-ns",
    strategy: "replace",
    entries: entriesFor(NAMESPACED_ENTRY_SPECS, runtime, OPENCODE_NAMESPACED_PROVIDER),
  };
}

function handlerMap(entries: readonly WiringEntry[]): string {
  const rows = entries.map(
    (entry) => `  ${JSON.stringify(entry.hookEvent)}: ${JSON.stringify(entry.handler)}`,
  );
  return `{\n${rows.join(",\n")},\n}`;
}

function launcherArgv(entries: readonly WiringEntry[]): string {
  const first = entries[0];
  if (first === undefined) {
    return "[]";
  }
  // invariant: every entry shares one command and one `--provider` prefix; only the trailing handler differs.
  return JSON.stringify([first.command, ...first.args.slice(0, -1)]);
}

function timeoutMs(entries: readonly WiringEntry[]): number {
  return Math.max(1, ...entries.map((entry) => entry.timeoutSeconds)) * 1000;
}

/**
 * The half of the bridge both generations share: shell out to the launcher with the envelope on stdin, and read
 * a core decision back off stdout.
 *
 * why it is generated rather than shipped as a file the plugin imports: opencode loads this module from its own
 * plugins directory, which is not inside this package. A relative import would break the moment the runtime moved,
 * and that is the failure `TLC_HOME` exists to prevent elsewhere.
 */
function bridgePreamble(wiring: ProviderWiring<ProviderWiringKind>, generation: string): string {
  return `// ${OPENCODE_MANAGED_MARKER} — generated by \`tlc harness update\`. Edits here are overwritten.
// pluginApi: ${generation}
import { spawnSync } from "node:child_process";

const LAUNCHER = ${launcherArgv(wiring.entries)};
const HANDLER_BY_HOOK = ${handlerMap(wiring.entries)};
const TIMEOUT_MS = ${timeoutMs(wiring.entries)};

function decide(hook, payload) {
  const handler = HANDLER_BY_HOOK[hook];
  if (!handler) {
    return null;
  }
  const [command, ...prefix] = LAUNCHER;
  const result = spawnSync(command, [...prefix, handler], {
    input: JSON.stringify({ provider: "opencode", pluginApi: ${JSON.stringify(generation)}, hook, ...payload }),
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
`;
}

function renderOpencodeLegacyPlugin(wiring: ProviderWiring<ProviderWiringKind>): string {
  return `${bridgePreamble(wiring, "legacy")}
export const TlcHarness = async () => ({
  "tool.execute.before": async (input, output) => {
    const decision = decide("tool.execute.before", {
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
    decide("tool.execute.after", {
      sessionID: input.sessionID,
      tool: input.tool,
      args: output?.args ?? input.args,
    });
  },
});
`;
}

function renderOpencodeNamespacedPlugin(wiring: ProviderWiring<ProviderWiringKind>): string {
  return `${bridgePreamble(wiring, "namespaced")}import { Plugin } from "@opencode-ai/plugin";

export default Plugin.define({
  id: "tlc-harness",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      const decision = decide("tool.execute.before", {
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
      const decision = decide("tool.execute.after", {
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
      const decision = decide("shell.create.before", {
        sessionID: event.sessionID,
        command: event.command,
        cwd: event.cwd,
      });
      if (decision && decision.kind === "deny") {
        throw new Error(decision.reason);
      }
    });
    await ctx.permission.hook("evaluate", (event) => {
      const decision = decide("permission.evaluate", {
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
  },
});
`;
}

export function renderOpencodePlugin(wiring: ProviderWiring<ProviderWiringKind>): string | null {
  if (wiring.kind === "opencode-plugin") {
    return renderOpencodeLegacyPlugin(wiring);
  }
  if (wiring.kind === "opencode-plugin-ns") {
    return renderOpencodeNamespacedPlugin(wiring);
  }
  return null;
}

/** invariant: the same question `applyCursorWiring` asks of a hooks file — is this file ours to replace? */
export function isOpencodeManaged(text: string | null): boolean {
  return text?.includes(OPENCODE_MANAGED_MARKER) ?? false;
}
