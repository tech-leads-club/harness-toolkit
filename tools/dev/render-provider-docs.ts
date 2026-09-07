import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HarnessEventKind, ProviderCapabilities } from "../../src/contracts/index.ts";
import { providers } from "../../src/providers/provider.registry.ts";
import { replaceRegion } from "./render-capabilities.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// invariant: a provider's doc file is `<name>.md` by convention (the shape `new-provider.ts` scaffolds).
// `claude-code.md` predates this feature and is the one name that does not match its provider's own name —
// renaming it would break every existing cross-reference into it, so it is named here instead.
const DOC_FILE_OVERRIDES: Record<string, string> = { claude: "claude-code.md" };

function docFileFor(name: string): string {
  return join("docs", "providers", DOC_FILE_OVERRIDES[name] ?? `${name}.md`);
}

export type ToolNameFanOutRule = { match: RegExp | string; kind: HarnessEventKind };

export type ProviderInboundModule = {
  EVENT_KIND_BY_HOOK?: Record<string, HarnessEventKind>;
  PRE_TOOL_USE_FAN_OUT?: readonly ToolNameFanOutRule[];
  POST_TOOL_USE_FAN_OUT?: readonly ToolNameFanOutRule[];
};

const CAPABILITY_FIELDS: readonly (keyof ProviderCapabilities)[] = [
  "enforcesHooks",
  "askSupportedOn",
  "sessionEnv",
  "nativeLoopCounter",
  "dedicatedShellEvent",
  "toolInputRewrite",
  "toolOutputRewriteOn",
  "contextAtToolBefore",
  "contextAtToolAfter",
  "contextAtStop",
  "sessionStartContextReliable",
  "toolOutputAtAfter",
  "usageInPayload",
  "effortSignal",
  "thoughtEvent",
];

export function renderCapabilityTable(capabilities: ProviderCapabilities): string {
  const rows = CAPABILITY_FIELDS.map(
    (field) => `| \`${field}\` | \`${JSON.stringify(capabilities[field])}\` |`,
  );
  return ["| Capability | Value |", "|---|---|", ...rows].join("\n");
}

function describeMatch(match: RegExp | string): string {
  return typeof match === "string" ? `tool_name === "${match}"` : `tool_name matches \`${match.source}\``;
}

export function renderEventMappingTable(mod: ProviderInboundModule): string {
  const byHook = mod.EVENT_KIND_BY_HOOK ?? {};
  const hasFanOut = mod.PRE_TOOL_USE_FAN_OUT !== undefined || mod.POST_TOOL_USE_FAN_OUT !== undefined;

  if (!hasFanOut) {
    const rows = Object.entries(byHook).map(([hook, kind]) => `| \`${hook}\` | \`${kind}\` |`);
    return ["| Hook | HarnessEventKind |", "|---|---|", ...rows].join("\n");
  }

  const rows = [
    ...Object.entries(byHook).map(([hook, kind]) => `| \`${hook}\` | — | \`${kind}\` |`),
    ...(mod.PRE_TOOL_USE_FAN_OUT ?? []).map(
      (rule) => `| \`PreToolUse\` | ${describeMatch(rule.match)} | \`${rule.kind}\` |`,
    ),
    ...(mod.POST_TOOL_USE_FAN_OUT ?? []).map(
      (rule) => `| \`PostToolUse\` | ${describeMatch(rule.match)} | \`${rule.kind}\` |`,
    ),
  ];
  return ["| Hook | Fan-out rule | HarnessEventKind |", "|---|---|---|", ...rows].join("\n");
}

async function loadInboundModule(root: string, name: string): Promise<ProviderInboundModule | null> {
  const path = join(root, "src", "providers", name, `${name}.inbound.ts`);
  try {
    return (await import(pathToFileURL(path).href)) as ProviderInboundModule;
  } catch {
    return null;
  }
}

// why: a provider doc missing its marker, or an inbound module missing the exported table, is a gap this
// generator reports and steps around — not an uncaught throw that stops every other provider's doc from
// rendering ([spec P1's edge cases]).
export async function renderAll(root = repoRoot): Promise<{ file: string; current: string; next: string }[]> {
  const results: { file: string; current: string; next: string }[] = [];
  for (const provider of providers) {
    const file = docFileFor(provider.name);
    let current: string;
    try {
      current = readFileSync(join(root, file), "utf8");
    } catch {
      console.error(`render-provider-docs: no doc file for provider "${provider.name}" — expected ${file}`);
      continue;
    }

    let next = current;
    try {
      next = replaceRegion(next, "capabilities", renderCapabilityTable(provider.capabilities()));
    } catch (error) {
      console.error(`render-provider-docs: ${file} — ${(error as Error).message}`);
    }

    const inbound = await loadInboundModule(root, provider.name);
    if (inbound?.EVENT_KIND_BY_HOOK === undefined) {
      console.error(
        `render-provider-docs: ${provider.name}.inbound.ts does not export EVENT_KIND_BY_HOOK — event-mapping table skipped`,
      );
    } else {
      try {
        next = replaceRegion(next, "event-mapping", renderEventMappingTable(inbound));
      } catch (error) {
        console.error(`render-provider-docs: ${file} — ${(error as Error).message}`);
      }
    }

    results.push({ file, current, next });
  }
  return results;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const results = await renderAll();
  const stale = results.filter((result) => result.current !== result.next);

  if (!check) {
    for (const result of stale) {
      writeFileSync(join(repoRoot, result.file), result.next, "utf8");
    }
    console.log(`render-provider-docs: ${stale.length} file(s) rewritten`);
    process.exit(0);
  }

  if (stale.length === 0) {
    console.log("render-provider-docs: generated regions match provider code");
    process.exit(0);
  }
  console.error(
    "render-provider-docs: generated regions are out of date — run: node tools/dev/render-provider-docs.ts",
  );
  for (const result of stale) {
    console.error(`  ${result.file}`);
  }
  process.exit(1);
}
