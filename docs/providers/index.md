---
type: Aggregate
title: "Providers index"
description: "Index of the provider adapters — Cursor and Claude Code — and the port they both implement."
tags: [providers, index, architecture]
timestamp: "2026-07-29"
---

# Providers

Core steering logic never imports a provider adapter and never reads a provider name. Each provider is an
anti-corruption-layer adapter implementing `ProviderPort`
(`src/providers/provider.port.ts`):

```ts
type ProviderPort = {
  readonly name: string;
  detect(raw: unknown): boolean;
  capabilities(): ProviderCapabilities;
  policyDefaults(): ProviderPolicyDefaults;
  toEvent(raw: Record<string, unknown>): HarnessEvent | null;
  render(decision: Decision, event: HarnessEvent): Rendered;
  wiring(runtime: RuntimePaths): ProviderWiring;
};
```

- `detect` — does this raw hook payload belong to this provider?
- `capabilities` — a declarative `ProviderCapabilities` descriptor (see
  [/architecture.md](/architecture.md)); core degrades on this data, never on `name`.
- `policyDefaults` — this provider's own model allowlist / blocked patterns / minimum effort (see
  [/decisions/ad-011.md](/decisions/ad-011.md)).
- `toEvent` — parses a raw hook payload into the shared `HarnessEvent` shape.
- `render` — turns a core `Decision` back into this provider's wire format.
- `wiring` — describes which hooks this provider needs registered, and where.

## Registered providers

Detection runs in registry order (`src/providers/provider.registry.ts`), first match wins, and multiple
matches are reported as ambiguous rather than silently resolved:

| Provider | Detected by | Docs |
| --- | --- | --- |
| Cursor | camelCase `hook_event_name` + `workspace_roots` array | [/providers/cursor.md](/providers/cursor.md) |
| Claude Code | PascalCase `hook_event_name` + `cwd` or `transcript_path` | [/providers/claude-code.md](/providers/claude-code.md) |

## Event kinds

Both adapters translate into the same 18-member `HarnessEventKind` union (see
[/decisions/ad-009.md](/decisions/ad-009.md) item 1): `session.start`, `session.end`, `prompt.submit`,
`tool.before`, `tool.after`, `tool.failure`, `shell.before`, `shell.after`, `mcp.before`, `mcp.after`,
`read.before`, `edit.after`, `subagent.start`, `subagent.stop`, `stop`, `compact.before`, `response.after`,
`thought.after`. A provider that cannot produce a kind is gated by its capability descriptor, not by the
kind's absence.

## Caller identity vs. spawn target

`HarnessEvent` splits two fields that an earlier design conflated (see
[/decisions/ad-016.md](/decisions/ad-016.md) item 1):

| Field | Meaning |
| --- | --- |
| `subagentType` | the identity of the agent **currently running** (the caller) |
| `spawnSubagentType` | the type of subagent a Task/spawn call **targets** |
| `model` | the current/parent model |
| `spawnModel` | the model of the child being spawned |

## Adding a provider

A new provider is a new directory under `src/providers/<name>/` plus one line in
`src/providers/provider.registry.ts` (see [/decisions/ad-004.md](/decisions/ad-004.md) and
[/decisions/ad-009.md](/decisions/ad-009.md) item 7) — never a change to `core/`. `node
tools/dev/new-provider.ts <name>`, run from a clone, scaffolds the stub files and a doc skeleton — a
contributor-only tool, not a published CLI command ([/decisions/ad-126.md](/decisions/ad-126.md)).
