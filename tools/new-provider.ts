import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// hazard: this file lived at tools/dev/new-provider.ts (two levels below root) until it moved to tools/ —
// tools/dev/ is excluded from the published package, and bin/tlc-cli.ts's `new-provider` subcommand imports
// this module at runtime, so a real install had no file to import at all.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

// why: assembled here so \`tlc harness new-provider\` has one ProviderPort to import into provider.registry.ts.
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
    // shape claude/index.ts and cursor/index.ts already use — without them there is no ProviderPort value for T6
    // to register or T7 to run through assertSatisfiesContract (see commit 20da58e).
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

export function main(argv: string[], root = repoRoot): void {
  const name = argv[0];
  if (!name) {
    console.error("usage: node tools/dev/new-provider.ts <name>");
    process.exitCode = 1;
    return;
  }
  const result = scaffold(name, root);
  if (!result.ok) {
    console.error(`new-provider: refusing — ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`new-provider: scaffolded src/providers/${name}/ and docs/providers/${name}.md`);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
