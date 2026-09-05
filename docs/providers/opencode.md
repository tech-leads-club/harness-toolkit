---
type: Provider
title: "opencode provider"
description: "The opencode adapter — two registered generations of the plugin API, the bridge plugin each emits, one shared inbound fan-out, and the opencode.json instructions carrier."
tags: [provider, opencode]
timestamp: "2026-09-05"
---

# opencode provider

Source: `src/providers/opencode/`. Registered **twice**, as `opencode-legacy` and `opencode-namespaced`.

## Why two adapters

opencode ships two plugin APIs in the same binary. The legacy API registers flat hook keys
(`"tool.execute.before"`); the namespaced API, available from v1.17.10 and still beta, registers through
`ctx.tool.hook("execute.before")` and adds two interception points the legacy API does not have:
`ctx.shell.hook("create.before")` and `ctx.permission.hook("evaluate")`, whose `effect` accepts `"ask"`.

`capabilities()` takes no arguments, so one adapter would have to pick: claim an ask channel the legacy API
cannot honour, or throw away the one the namespaced API offers. The first is unsafe in the exact way capability
descriptors exist to prevent. So opencode registers twice, sharing one inbound parser and one fan-out, and
differing in `capabilities()`, `wiring()`, and the bridge plugin each emits
([/decisions/ad-124.md](/decisions/ad-124.md)).

## Detection

`opencode.detect.ts`. opencode does not pipe its own payload to the launcher — it loads a **bridge plugin this
harness writes**, and that bridge stamps the envelope. Detection is a marker check on a harness-defined shape,
not a fingerprint of a vendor one:

| Adapter | Detected by |
| --- | --- |
| `opencode-legacy` | `provider: "opencode"` **and** `pluginApi: "legacy"` |
| `opencode-namespaced` | `provider: "opencode"` **and** `pluginApi: "namespaced"` |

The two are mutually exclusive on `pluginApi`, which is what keeps `resolveFromRegistry` from reporting
`ambiguous` with both registered. An unknown generation marker — a future `pluginApi: "v3"` — is claimed by
neither, and the run records `adapter.unrecognized` rather than being parsed by whichever adapter happens to come
first. Each bridge also launches with `--provider <its own name>`, so the hint channel settles routing before a
detector runs; the markers are the belt to that pair of braces.

## Capability descriptors

`opencode.capabilities.ts`, one per generation. The six rows they disagree on are exactly the six the two
references settle differently — a value copied across the boundary collapses that list and fails the test.

| Capability | legacy | namespaced |
| --- | --- | --- |
| `enforcesHooks` | `true` | `true` |
| `askSupportedOn` | `[]` — no permission-evaluation hook | `["shell.before", "mcp.before", "read.before", "tool.before"]` — `permission.hook("evaluate")` takes `effect: "ask"` |
| `sessionEnv` | `false` | `false` |
| `nativeLoopCounter` | `false` | `false` |
| `dedicatedShellEvent` | `false` — no shell hook | `true` — `shell.hook("create.before")` |
| `toolInputRewrite` | `true` — `output.args` is mutable at `tool.execute.before` | `false` — undocumented on this generation |
| `toolOutputRewrite` | `true` — the weakest value in the table; it rests on the transcription alone | `true` — a mutable `event.result` on `execute.after` |
| `contextAtToolBefore` | `true` | `false` |
| `contextAtToolAfter` | `false` | `true` |
| `contextAtStop` | `false` | `false` |
| `sessionStartContextReliable` | `false` | `false` |
| `toolOutputAtAfter` | `false` | `true` |
| `usageInPayload` | `false` | `false` |
| `effortSignal` | `false` | `false` |
| `thoughtEvent` | `false` | `false` |

The newer API is not uniformly stronger: `toolInputRewrite` is documented on legacy and undocumented on
namespaced, which is the inversion the design had not looked at.

## Policy defaults

`opencode.policy-defaults.ts` is shared by both generations — they run the same binary and the same tool set.
`webfetch` and `websearch` are untrusted, in opencode's own lower-case spellings. No blocked model pattern.

## Event mapping

`opencode.inbound.ts`, one parser for both generations: the two differ in what the harness can *do*, not in the
shape the bridge puts on stdin. The envelope's `pluginApi` stamp decides `event.provider`.

| Bridge hook | Condition | `HarnessEventKind` |
| --- | --- | --- |
| `tool.execute.before` | `bash`, `shell` | `shell.before` |
| `tool.execute.before` | `mcp_*` prefix | `mcp.before` |
| `tool.execute.before` | `read` | `read.before` |
| `tool.execute.before` | otherwise | `tool.before` |
| `tool.execute.after` | `bash`, `shell` | `shell.after` |
| `tool.execute.after` | `mcp_*` prefix | `mcp.after` |
| `tool.execute.after` | `edit`, `write`, `patch`, `apply_patch` | `edit.after` |
| `tool.execute.after` | otherwise | `tool.after` |
| `shell.create.before` | namespaced only | `shell.before`, without the tool fan-out |
| `permission.evaluate` | namespaced only, and only when the bridge stamped a tool | the before-kind for that tool |

An unrecognized tool name falls to the generic kind rather than returning `null`, on both generations.

Two spellings of the patch tool are accepted: the tools reference names `apply_patch`, while the fan-out table and
the fixtures say `patch`. Accepting one would send half the edits to the generic kind.

`permission.evaluate` stays unmapped when the bridge stamps no tool. Its documented payload carries `sessionID`,
`action`, `resources`, `effect` and `message` — no tool — and an ask channel a rule cannot match on is worse than
no event at all. Whether opencode's `action` string resolves to a tool identity is undocumented, and it is the
one thing a live namespaced session must settle for the ask capability to be true in practice rather than only in
the descriptor.

`status` accepts `completed` and `error`, opencode's own two values. There is no `aborted` on this host.
`projectDir` reads `TLC_PROJECT_DIR` and never a vendor variable, because opencode documents no environment given
to a plugin.

## Outbound — the bridge interprets, not an outbound file

There is no `opencode.outbound.ts`. The adapter returns the core-shaped decision and the emitted bridge plugin
interprets it: a deny throws, `context` appends, a rewrite merges into the tool arguments, and allow / abstain /
continue are no-ops. On the namespaced generation, an `ask` sets `effect: "ask"` with the decision's reason
rather than degrading — which is the behaviour its descriptor promises.

## Wiring targets

| Adapter | kind | target |
| --- | --- | --- |
| `opencode-legacy` | `opencode-plugin` | `~/.config/opencode/plugins/tlc-harness.js` |
| `opencode-namespaced` | `opencode-plugin-ns` | `~/.config/opencode/plugins/tlc-harness/index.ts` |

Both are `strategy: "replace"`: the module is generated wholesale, so the only file that behaves is the one this
build would write. Each carries a managed-file marker in a header comment, and a file without it was written by a
human and is refused rather than overwritten unless `--force` is given.

Four details worth knowing:

- **The legacy bridge is `.js`, not `.mjs`.** The plugin reference documents JavaScript and TypeScript plugin
  files; `.mjs` is documented nowhere, and this file is loaded by the host.
- **The namespaced bridge is `.ts`.** Its documented entry point is TypeScript, and whether a plain `.mjs` module
  is accepted at that path is not documented either way.
- **Both targets are user-global.** The namespaced generation documents only a *project* path and no global one;
  `wiring()` is handed a launcher path and no project root, which is why every host here is wired user-level.
  Recorded as the weak point of this writer.
- **Host presence is the plugins directory, not the plugin's own.** The namespaced plugin lives in a directory
  only this writer creates, so asking whether *it* exists would answer "opencode is not installed" on every
  machine for ever.

Doctor reads the bridge by **byte-equality**, not by marker presence: a bridge from an older build still carries
the marker and still names a launcher while calling a handler set that has since changed.

## Lessons view

`opencode.lessons-view.ts` appends `.tlc/harness/lessons.md` to the `instructions` array in the project's
`opencode.json`, project-relative — the documented form, and the only one that survives a clone. opencode's rules
reference documents that array as combined with `AGENTS.md`.

Unlike every other host here, this is the **only** carrier: `sessionStartContextReliable` is `false` on both
generations, so lessons cannot ride a session-start hook.

- **Idempotent by returning before any write.** An entry already present — ours or the operator's, in their own
  formatting — is left exactly as it is, so a second run is byte-identical rather than merely equivalent.
- **A config that does not parse is untouched and reported** on stderr. So is one that parses to an array or a
  scalar. A corrupted config breaks the operator's whole host, which is strictly worse than missing lessons.
- **The namespaced evidence gap stands.** The `instructions` array is documented in the legacy documentation set,
  and the v2 configuration page could not be resolved. The named fallback if v2 does not honour it: that
  generation documents a `session.context` hook whose `event.system.push({ text })` injects into the outgoing
  model call, which the bridge already emits could carry.

## See also

- [/providers/index.md](/providers/index.md)
- [/decisions/ad-124.md](/decisions/ad-124.md)
