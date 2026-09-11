import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// hazard: this was briefly reachable as a published CLI subcommand — a real install's runtime home wipes
// src/providers/<name>/ on every update, so nothing scaffolded there ever survived
// ([/decisions/ad-126.md](/decisions/ad-126.md)). Contributor-only:
// run from a repo clone as `node tools/dev/new-provider.ts <name>`, never via an installed `tlc`.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// invariant: mirrors provider.contract.test.ts's own safety check ("provider name is safe as a state-file
// key segment") — no whitespace, no slashes. Reserved names collide with this scaffold's own file layout
// (`index.ts`) or the generic module concept ("provider").
const UNSAFE_NAME = /[\s/\\]/;
const RESERVED_NAMES = new Set(["index", "provider"]);

export type NameValidity = { ok: true } | { ok: false; reason: string };

export function validateProviderName(name: string): NameValidity {
  if (name.length === 0) {
    return { ok: false, reason: "provider name must not be empty" };
  }
  if (UNSAFE_NAME.test(name)) {
    return { ok: false, reason: "provider name must not contain whitespace or a slash" };
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return { ok: false, reason: `"${name}" is a reserved name` };
  }
  return { ok: true };
}

function capitalize(name: string): string {
  return name.length === 0 ? name : `${name[0]?.toUpperCase()}${name.slice(1)}`;
}

function detectStub(name: string): string {
  const cap = capitalize(name);
  return `// why: always false until real detection logic replaces it, so the provider stays inert.
export function detect${cap}(_raw: unknown): boolean {
  return false;
}
`;
}

function capabilitiesStub(name: string): string {
  return `import type { HarnessEventKind, ProviderCapabilities } from "../../contracts/index.ts";

export function ${name}Capabilities(): ProviderCapabilities {
  return {
    enforcesHooks: true,
    askSupportedOn: [],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: false,
    // why: a placeholder, deliberately not a real HarnessEventKind — fails assertSatisfiesContract until replaced.
    toolOutputRewriteOn: ["TODO-fill-in-real-capabilities" as unknown as HarnessEventKind],
    contextAtToolBefore: false,
    contextAtToolAfter: false,
    contextAtStop: false,
    sessionStartContextReliable: false,
    toolOutputAtAfter: false,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  };
}
`;
}

function policyDefaultsStub(name: string): string {
  return `import type { ProviderPolicyDefaults } from "../../contracts/index.ts";

export function ${name}PolicyDefaults(): ProviderPolicyDefaults {
  return {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: [],
  };
}
`;
}

function inboundStub(name: string): string {
  return `import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";

// why: empty until this host's own hook names are mapped, so every payload falls through to null.
export const EVENT_KIND_BY_HOOK: Record<string, HarnessEventKind> = {};

/** Never throws on a malformed payload — returns null instead. */
export function ${name}ToEvent(_raw: Record<string, unknown>): HarnessEvent | null {
  return null;
}
`;
}

function wiringStub(name: string): string {
  return `import type { ProviderWiring, RuntimePaths } from "../../contracts/index.ts";

// why: a placeholder path, until the real file this provider's host reads hooks from is named.
const WIRING_TARGET = "TODO: replace with the real wiring target path";

export function ${name}WiringTargets(): string[] {
  return [WIRING_TARGET];
}

// why: an empty entries list, until this adapter's real hook entries replace it (see claude.wiring.ts's ENTRY_SPECS shape).
export function ${name}Wiring(_runtime: RuntimePaths): ProviderWiring {
  return { target: WIRING_TARGET, strategy: "replace", entries: [] };
}
`;
}

function outboundStub(name: string): string {
  return `import type { Decision, HarnessEvent, Rendered } from "../../contracts/index.ts";

// why: an unconditional abstain, until this host's real hook response schema replaces it.
export function ${name}Render(_decision: Decision, _event: HarnessEvent): Rendered {
  return { stdout: null, exitCode: 0 };
}
`;
}

function indexStub(name: string): string {
  const cap = capitalize(name);
  return `import type { ProviderPort } from "../provider.port.ts";
import { ${name}Capabilities } from "./${name}.capabilities.ts";
import { detect${cap} } from "./${name}.detect.ts";
import { ${name}ToEvent } from "./${name}.inbound.ts";
import { ${name}Render } from "./${name}.outbound.ts";
import { ${name}PolicyDefaults } from "./${name}.policy-defaults.ts";
import { ${name}Wiring, ${name}WiringTargets } from "./${name}.wiring.ts";

// why: assembled here so the scaffold has one ProviderPort to append into provider.registry.ts.
export const ${name}Provider: ProviderPort = {
  name: "${name}",
  detect: detect${cap},
  capabilities: ${name}Capabilities,
  policyDefaults: ${name}PolicyDefaults,
  toEvent: ${name}ToEvent,
  render: ${name}Render,
  wiring: ${name}Wiring,
  wiringTargets: ${name}WiringTargets,
};
`;
}

function docSkeleton(name: string): string {
  const cap = capitalize(name);
  const timestamp = new Date().toISOString().slice(0, 10);
  return `---
type: Provider
title: "${cap} provider"
description: "The ${cap} adapter — capability descriptor, event mapping, and wiring target."
tags: [provider, ${name}]
timestamp: "${timestamp}"
---

# ${cap} provider

Source: \`src/providers/${name}/\`.

## Detection

TODO: describe \`${name}.detect.ts\`'s real detection rule.

## Capability descriptor

\`${name}.capabilities.ts\`:

<!-- generated:capabilities -->

<!-- /generated -->

## Policy defaults

TODO: describe \`${name}.policy-defaults.ts\`'s defaults.

## Event mapping

\`${name}.inbound.ts\` maps ${cap}'s own hook names to \`HarnessEventKind\`:

<!-- generated:event-mapping -->

<!-- /generated -->

## Wiring target

TODO: describe \`${name}.wiring.ts\`'s wiring target and strategy.

## See also

- [/providers/index.md](/providers/index.md)
`;
}

export type ScaffoldFile = { path: string; content: string };

export function scaffoldFiles(name: string): ScaffoldFile[] {
  const dir = join("src", "providers", name);
  return [
    { path: join(dir, `${name}.detect.ts`), content: detectStub(name) },
    { path: join(dir, `${name}.capabilities.ts`), content: capabilitiesStub(name) },
    { path: join(dir, `${name}.policy-defaults.ts`), content: policyDefaultsStub(name) },
    { path: join(dir, `${name}.inbound.ts`), content: inboundStub(name) },
    { path: join(dir, `${name}.wiring.ts`), content: wiringStub(name) },
    // why: SPEC_DEVIATION — emits 8 files, not the 6 named in design.md/tasks.md, adding `<name>.outbound.ts` and
    // `index.ts`. Reason: ProviderPort requires a `render` field and an assembled object, the same two-extra-file
    // shape claude/index.ts and cursor/index.ts already use — without them there is no ProviderPort value for
    // runNewProvider to register or for a contract test to run through assertSatisfiesContract (see commit 20da58e).
    { path: join(dir, `${name}.outbound.ts`), content: outboundStub(name) },
    { path: join(dir, "index.ts"), content: indexStub(name) },
    { path: join("docs", "providers", `${name}.md`), content: docSkeleton(name) },
  ];
}

export function scaffold(name: string, root = repoRoot): NameValidity {
  const validity = validateProviderName(name);
  if (!validity.ok) {
    return validity;
  }
  const providerDir = join(root, "src", "providers", name);
  if (existsSync(providerDir)) {
    return { ok: false, reason: `${join("src", "providers", name)} already exists` };
  }
  for (const file of scaffoldFiles(name)) {
    const fullPath = join(root, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, "utf8");
  }
  return { ok: true };
}

const REGISTRY_TYPE_IMPORT = 'import type { ProviderPort } from "./provider.port.ts";\n';
const REGISTRY_ARRAY = /export const providers: ProviderPort\[\] = \[([^\]]*)\];/;

// invariant: an append, never a reorder — the new entry always lands last in `providers`, so every existing
// provider's detection-order position is unchanged.
export function appendProviderToRegistry(text: string, name: string): string {
  if (!text.includes(REGISTRY_TYPE_IMPORT)) {
    throw new Error("provider.registry.ts: could not find the ProviderPort type-import anchor line");
  }
  const withImport = text.replace(
    REGISTRY_TYPE_IMPORT,
    `import { ${name}Provider } from "./${name}/index.ts";\n${REGISTRY_TYPE_IMPORT}`,
  );

  const match = REGISTRY_ARRAY.exec(withImport);
  if (!match) {
    throw new Error("provider.registry.ts: could not find the providers array literal");
  }
  const existing = (match[1] ?? "").trim();
  const appended = existing.length > 0 ? `${existing}, ${name}Provider` : `${name}Provider`;
  return withImport.replace(REGISTRY_ARRAY, `export const providers: ProviderPort[] = [${appended}];`);
}

/**
 * The full scaffold flow: scaffold() first, then a real import appended to provider.registry.ts — in that
 * order, so a refused scaffold never touches the registry.
 */
export function runNewProvider(name: string, root: string): { ok: true } | { ok: false; reason: string } {
  const scaffolded = scaffold(name, root);
  if (!scaffolded.ok) {
    return scaffolded;
  }
  const registryPath = join(root, "src", "providers", "provider.registry.ts");
  const current = readFileSync(registryPath, "utf8");
  writeFileSync(registryPath, appendProviderToRegistry(current, name), "utf8");
  return { ok: true };
}

export function main(argv: string[], root = repoRoot): void {
  const name = argv[0];
  if (!name) {
    console.error("usage: node tools/dev/new-provider.ts <name>");
    process.exitCode = 1;
    return;
  }
  const result = runNewProvider(name, root);
  if (!result.ok) {
    console.error(`new-provider: refusing — ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `new-provider: scaffolded src/providers/${name}/, docs/providers/${name}.md, and appended ${name}Provider to provider.registry.ts`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
