---
type: Provider
title: "Codex CLI provider"
description: "The Codex adapter — fingerprint detection ahead of Claude, its capability descriptor, the two response vocabularies its events use, and the hooks.json merge."
tags: [provider, codex]
timestamp: "2026-09-05"
---

# Codex CLI provider

Source: `src/providers/codex/`. Registered as `codex`, **ahead of Claude Code** in
`src/providers/provider.registry.ts`.

## Detection

`codex.detect.ts`. Codex emits a payload shaped like Claude's — PascalCase `hook_event_name`, `cwd`,
`transcript_path` — so there is no field that says "Codex". What there is instead is a set of things only Codex
produces, and any one of them is enough:

- `hook_event_name` of `PermissionRequest` or `PostCompact` — two events Claude does not have
- `tool_name` of `apply_patch` — Codex's own patch tool, where Claude says `Edit` / `Write`
- a `transcript_path` or `agent_transcript_path` with a `.codex` path **segment** (a substring test would claim
  `/repo/my.codex-notes/x.jsonl`, which is not a Codex transcript)

Two consequences worth knowing:

- **Claude declines a Codex-fingerprinted payload outright.** Registry order alone resolves to Codex, but
  `resolveFromRegistry` reports `ambiguous` whenever two detectors match, and `run.ts` records that. Every
  fingerprinted Codex hook would have written an `adapter.ambiguous` record, turning a signal for a real
  collision into a line an operator learns to ignore.
- **Codex's remaining events carry no fingerprint at all.** That is the honest boundary of content detection
  here, and it is why the wiring launches with `--provider codex`: the hint channel routes a real session, and
  the detector is what claims a payload from a hook someone wired by hand.

## Capability descriptor

`codex.capabilities.ts`. Every value is cited in [/decisions/ad-123.md](/decisions/ad-123.md), against OpenAI's
published hooks reference or behaviour measured in the feature's source transcription.

| Capability | Value |
| --- | --- |
| `enforcesHooks` | `true` |
| `askSupportedOn` | `[]` — the reference states `permissionDecision: "ask"` is *parsed but unsupported*: Codex parses it and runs the tool anyway |
| `sessionEnv` | `false` — `PLUGIN_ROOT` / `PLUGIN_DATA` are documented for plugin-bundled hooks only |
| `nativeLoopCounter` | `false` — `stop_hook_active` is a boolean and the flag claims a count |
| `dedicatedShellEvent` | `false` — shell is `PreToolUse` with a `^Bash$` matcher |
| `toolInputRewrite` | `true` — `PreToolUse` accepts `updatedInput` |
| `toolOutputRewrite` | `false` |
| `contextAtToolBefore` | `true` |
| `contextAtToolAfter` | `true` |
| `contextAtStop` | `false` — `Stop` documents only `decision: "block"` with `reason` |
| `sessionStartContextReliable` | `true` — the least certain value in the table; a host can accept a field and drop it |
| `toolOutputAtAfter` | `true` — `PostToolUse` carries `tool_response` |
| `usageInPayload` | `false` |
| `effortSignal` | `false` |
| `thoughtEvent` | `false` |

`askSupportedOn: []` is the load-bearing one. `degrade()` turns an `ask` rule into a `deny` for this host, so the
rule author still writes one rule and no core code learns a host name.

## Policy defaults

`codex.policy-defaults.ts` marks `WebSearch` untrusted — the one such tool the transcription records for this
host, deliberately not Claude's `WebFetch` or Cursor's `Fetch`. It is correct and currently unenforceable: the
same transcription records that `WebSearch` never reaches the Codex v1 hook pipeline. The entry stays so the day
the gap closes is not a day someone has to notice by hand.

No blocked model pattern: nothing equivalent to Cursor's measured fast-tier alias is documented here.

## Event mapping

`codex.inbound.ts`:

| Codex hook | Condition | `HarnessEventKind` |
| --- | --- | --- |
| `SessionStart` | — | `session.start` |
| `SessionEnd` | — | `session.end` |
| `UserPromptSubmit` | — | `prompt.submit` |
| `PreToolUse` / `PermissionRequest` | `tool_name === "Bash"` | `shell.before` |
| `PreToolUse` / `PermissionRequest` | `tool_name` matches `mcp__*` | `mcp.before` |
| `PreToolUse` / `PermissionRequest` | otherwise, **including `apply_patch`** | `tool.before` |
| `PostToolUse` | `tool_name === "Bash"` | `shell.after` |
| `PostToolUse` | `tool_name` matches `mcp__*` | `mcp.after` |
| `PostToolUse` | otherwise, **including `apply_patch`** | `tool.after` |
| `SubagentStart` | — | `subagent.start` |
| `SubagentStop` | — | `subagent.stop` |
| `Stop` | — | `stop` |
| `PreCompact` | — | `compact.before` |
| `PostCompact`, `Interrupt` | — | unmapped, deliberately |

**`apply_patch` stays generic, and that is the highest-risk mapping in the adapter.** Its `tool_input.command`
holds patch text, not a shell command, so a branch sending it to `shell.*` would feed patch bodies to every
shell-command rule an operator wrote and misclassify every edit as a shell execution. It is written as an
*absence* — no branch at all — so the test that guards it asserts two things: the kind is generic, and the event
carries no `command` field.

`PostCompact` and `Interrupt` are unmapped because `HarnessEventKind` has no compact-after and no interrupt
member. The detector still fingerprints `PostCompact` — claiming a payload and parsing it are different
questions — so such a hook resolves to Codex and then records `adapter.unrecognized`, which is the visible
failure rather than the silent one.

`PermissionRequest` shares `PreToolUse`'s fan-out: it is the same moment in the turn. The two differ only in the
response vocabulary, which the renderer tells apart by reading `event.raw.hook_event_name` — so the parser leaves
`raw` untouched.

## Outbound — two vocabularies from one function

`codex.outbound.ts`:

- **`PermissionRequest` answers only a refusal.** A deny renders
  `hookSpecificOutput.decision.behavior: "deny"` with a `message`, which is the shape Codex documents for this
  event and **not** the `permissionDecision` field `PreToolUse` uses. Everything else — allow, ask, abstain,
  rewrite, context, continue — renders empty stdout, so Codex's own prompt keeps control. The rule is "anything
  that is not a refusal", because the hazard is answering a human escalation at all.
- **A `PreToolUse` rewrite emits `permissionDecision: "allow"` together with `updatedInput`**, both inside
  `hookSpecificOutput`. Codex errors when `allow` is omitted — the opposite of Claude, which omits it.
- **An `ask` renders as a deny.** `askSupportedOn: []` means `degrade()` already converted it, so this branch is
  unreachable on the production path; it exists because emitting the ask faithfully would approve the exact
  action the rail wanted escalated.

## Wiring target

`codex.wiring.ts` merges (`strategy: "merge"`) into `$CODEX_HOME/hooks.json`, default `~/.codex/hooks.json`.
`CODEX_HOME` is the host's own documented variable, unlike the harness-defined overrides the other config
directories take.

Entries are emitted in Codex's documented shape,
`{ matcher, hooks: [{ type: "command", command, timeout }] }`, with the innermost `command` a **single quoted
string** rather than the `{ command, args }` exec form Claude uses — passing an array would leave every hook
unparsed. `failClosed` and `loopLimit` are absent, because the schema has no such fields.

Timeouts obey the vendor rule as data rather than as care taken while typing: at most 3 seconds on `SessionEnd`
and `Interrupt`, at most 600 elsewhere, with the ceiling exported and read by the test. No entry is registered
for `PostCompact` or `Interrupt`, because neither maps to a `HarnessEventKind` — a hook for either would launch a
process on every occurrence and drop the payload.

The merge mirrors Claude's: a hook group that does not reference `tlc-exec.mjs` survives byte-identical, ours are
replaced wholesale rather than appended to, keys outside `hooks` are preserved, a re-merge reports no change, and
a `hooks.json` that does not parse is refused with a block to paste rather than rewritten.

## Lessons view

`codex.lessons-view.ts` appends a plain markdown pointer to the project's `AGENTS.md` naming
`.tlc/harness/lessons.md`. Written under `intelligence.lessons.syncRulesFile: "always"` and **not** under the
default `"auto"`, because `sessionStartContextReliable` is `true`.

Never `@path`: Codex has no file-import syntax, and `AGENTS.md` is read by other tools too, so a directive that
looks like one and is not is worse than a sentence. Append-only and idempotent.

## Doctor / status

`tlc harness doctor` reports Codex wiring as `wired` when merging the current entries into the existing
`hooks.json` would produce no change, and adds a second row whenever Codex is installed:

> **codex hook trust** — not verified. Codex silently skips untrusted hooks. Run `/hooks` inside Codex to trust
> the file.

It is an `ok` row rather than a warning, because doctor cannot read Codex's trust store: a warning nothing it can
observe would ever clear is one an operator learns to scroll past.

## Known limitations

Recorded in [/decisions/ad-123.md](/decisions/ad-123.md), with what each costs:

- **`WebSearch` never reaches the v1 hook pipeline** — a `WebSearch` rail sees nothing.
- **`write_stdin` on an already-approved session never reaches it either** — an approved session can take further
  input the harness never sees.
- **`apply_patch` bodies are not parsed** — a path-scoped rule cannot gate an edit on this host.
- **Untrusted hooks are skipped in silence**, which is what the doctor row above exists for.

## See also

- [/providers/index.md](/providers/index.md)
- [/providers/claude-code.md](/providers/claude-code.md) — the payload shape this host resembles
- [/decisions/ad-123.md](/decisions/ad-123.md)
