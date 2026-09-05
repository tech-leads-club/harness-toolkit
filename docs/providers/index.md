---
type: Aggregate
title: "Providers index"
description: "Index of the provider adapters — Cursor, opencode on two plugin API generations, Codex CLI, VS Code, and Claude Code — the port they all implement, and the hint channel a host with no fingerprint needs."
tags: [providers, index, architecture]
timestamp: "2026-09-05"
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

| # | Provider | Registry name | Detected by | Docs |
| --- | --- | --- | --- | --- |
| 1 | Cursor | `cursor` | camelCase `hook_event_name` + `workspace_roots` array | [/providers/cursor.md](/providers/cursor.md) |
| 2 | opencode (legacy plugin API) | `opencode-legacy` | `provider: "opencode"` + `pluginApi: "legacy"`, stamped by the bridge this harness emits | [/providers/opencode.md](/providers/opencode.md) |
| 3 | opencode (namespaced plugin API) | `opencode-namespaced` | `provider: "opencode"` + `pluginApi: "namespaced"` | [/providers/opencode.md](/providers/opencode.md) |
| 4 | Codex CLI | `codex` | `hook_event_name` of `PermissionRequest` or `PostCompact`, or `tool_name` of `apply_patch`, or a `.codex` transcript path segment | [/providers/codex.md](/providers/codex.md) |
| 5 | VS Code (Agent Hooks, Preview) | `vscode` | **nothing** — the provider hint only | [/providers/vscode.md](/providers/vscode.md) |
| 6 | Claude Code | `claude` | PascalCase `hook_event_name` + `cwd` or `transcript_path`, and no non-`claude` hint set | [/providers/claude-code.md](/providers/claude-code.md) |

Two ordering facts carry that list:

- **Codex sits ahead of Claude.** Codex payloads are a superset-shaped sibling of Claude's, so ordered after
  Claude a Codex `PreToolUse` would be claimed by Claude's detector first. Claude also declines a
  Codex-fingerprinted payload outright, so the two never both match and the order is belt to that brace.
- **VS Code's position is inert.** Its detector fires only on the hint, and a hint bypasses the list entirely. It
  sits before Claude for readability.

## The provider hint

A host can emit another host's payload byte for byte. VS Code Agent Hooks emit Claude Code's exact PascalCase
JSON, so detection by content is not merely hard there, it is impossible — and no registry ordering fixes it. The
only sound answer is for the wiring that launched the hook to say which host it belongs to:

```
wiring entry args:   [<launcher>, "--provider", "vscode", "<handler>"]
bin/tlc-exec.mjs:    parses --provider, sets TLC_PROVIDER_HINT=<name> in the child environment
src/entrypoints/run.ts:
    const resolved = hint
      ? resolveByHint(hint, providerRegistry)     // exact name match, no detectors run
      : resolveFromRegistry(parsed, providerRegistry);
```

Three invariants make it safe:

- **No detector runs when a hint is set.** A hint that reached a detector could still lose to a provider earlier
  in the registry, which would make the hint advisory — and an advisory hint is the failure it exists to prevent.
- **An unmatched hint resolves to nothing.** The run records `adapter.unrecognized` and never falls back to
  detection. A hint naming a host the registry does not have is a wiring fault, and answering it with a guess
  hands the payload to an adapter that parses it into an event with fields quietly absent.
- **The launcher clears an inherited hint.** Otherwise an un-hinted hook would inherit the last hinted host and
  skip detection while appearing to work.

Codex and opencode also launch with `--provider`, even though both can be detected: most Codex events carry no
fingerprint at all, and the opencode markers exist to stop a hand-copied bridge resolving to the wrong
generation's descriptor.

## Wiring kinds

Install and doctor dispatch on `ProviderWiring.kind` — a closed union in `src/providers/provider.port.ts`, never
on a provider's name. `providerWiringStatus` in `tools/doctor.ts` ends in a `never` parameter, so a new member
fails `tsc --noEmit` until a reader handles it.

| Kind | Strategy | Target |
| --- | --- | --- |
| `cursor-hooks-json` | replace | `~/.cursor/hooks.json` |
| `claude-settings-json` | merge | `~/.claude/settings.json` |
| `opencode-plugin` | replace | `~/.config/opencode/plugins/tlc-harness.js` |
| `opencode-plugin-ns` | replace | `~/.config/opencode/plugins/tlc-harness.js` — the same file; see below |
| `codex-hooks-json` | merge | `$CODEX_HOME/hooks.json`, default `~/.codex/hooks.json` |
| `vscode-hooks-json` | replace | `~/.copilot/hooks/tlc-harness.json` — **never written**; see below |

**The two opencode kinds share one file.** opencode auto-discovers plugins with the flat glob
`{plugin,plugins}/*.{ts,js}`, so a nested target is never loaded and two sibling targets are both loaded, firing
every hook twice. The emitted module carries both register paths and selects the generation from the plugin input
the host hands it ([/decisions/ad-124.md](/decisions/ad-124.md)).

**VS Code wiring is deferred, not missing.** The writer exists and is tested against a golden file, and
`install`, `doctor` and `init` each take an explicit deferral branch while Agent Hooks are Preview
([/decisions/ad-126.md](/decisions/ad-126.md)).

## One rule, six hosts

The point of the table above is that none of it reaches a rule an operator writes. A rule says "ask before a
shell command touches `.env`". What differs per host is only what the harness can *do* with that:

| Host | What `ask` becomes | Why |
| --- | --- | --- |
| Cursor | an ask, on `shell.before` and `mcp.before` | those two events accept it |
| Claude Code | an ask, on all four before-kinds | `PreToolUse` accepts `permissionDecision: "ask"` |
| VS Code | an ask, on all four before-kinds | same field, same four kinds |
| opencode (namespaced) | an ask | `permission.hook("evaluate")` takes `effect: "ask"` |
| opencode (legacy) | a **deny**, carrying the rule that refused | that API has no permission-evaluation hook |
| Codex CLI | a **deny**, carrying the rule that refused | Codex parses `ask` and runs the tool anyway |

`degrade()` (`src/providers/provider.degrade.ts`) makes that conversion from the capability descriptor, so the
rule author writes one rule and no core code learns a host name. The same mechanism strips a `context` decision on
a host with no channel for it at that moment, rather than rendering it into a field the host ignores and leaving
the caller believing it was delivered.

## Event kinds

Every adapter translates into the same 18-member `HarnessEventKind` union (see
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

## Durable context

`sessionStartContextReliable` decides whether lessons need a file on disk at all. Where it is `true`, lessons ride
the session-start hook and the durable view is written only under
`intelligence.lessons.syncRulesFile: "always"`.

| Host | Reliable at session start | Durable carrier |
| --- | --- | --- |
| Cursor | `false` | `.cursor/rules/harness-lessons.mdc`, always |
| opencode (both) | `false` | the `instructions` array in `opencode.json`, always — the only carrier this host has |
| Claude Code | `true` | an `@.tlc/harness/lessons.md` import in `CLAUDE.md`, on request |
| Codex CLI | `true` | a plain markdown pointer in `AGENTS.md`, on request — Codex has no import syntax |
| VS Code | `true` | a plain markdown pointer in `.github/copilot-instructions.md`, on request |

## Adding a provider

A new provider is a new directory under `src/providers/<name>/` plus one line in
`src/providers/provider.registry.ts` (see [/decisions/ad-004.md](/decisions/ad-004.md) and
[/decisions/ad-009.md](/decisions/ad-009.md) item 7) — never a change to `core/`.

A wiring format it needs is a new member of `ProviderWiringKind` in `src/providers/provider.port.ts`, added by
the change that introduces its writer rather than ahead of it: the `never` guard in `providerWiringStatus` makes
each addition a compile error until a reader exists. Every capability flag it declares needs cited provenance in
a decision record — the vendor's own hook documentation, or behaviour measured against a running host — and
never a value carried across from another host. Overstating a capability produces no error, only a rail that
quietly does nothing.

## Per-host documents

- [/providers/cursor.md](/providers/cursor.md)
- [/providers/opencode.md](/providers/opencode.md)
- [/providers/codex.md](/providers/codex.md)
- [/providers/vscode.md](/providers/vscode.md)
- [/providers/claude-code.md](/providers/claude-code.md)
