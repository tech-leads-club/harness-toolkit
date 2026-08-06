---
type: Provider
title: "Cursor provider"
description: "The Cursor adapter — capability descriptor, event mapping, and wiring target for Cursor's hooks.json."
tags: [provider, cursor]
timestamp: "2026-07-29"
---

# Cursor provider

Source: `src/providers/cursor/`.

## Detection

`cursor.detect.ts`: a raw hook payload is Cursor's when `hook_event_name` is camelCase (e.g.
`beforeShellExecution`) and `workspace_roots` is an array.

## Capability descriptor

`cursor.capabilities.ts`:

| Capability | Value |
| --- | --- |
| `enforcesHooks` | `true` |
| `askSupportedOn` | `["shell.before", "mcp.before"]` — **not** `tool.before` (see [/decisions/ad-009.md](/decisions/ad-009.md), note) |
| `sessionEnv` | `true` |
| `nativeLoopCounter` | `true` |
| `dedicatedShellEvent` | `true` |
| `toolInputRewrite` | `true` |
| `toolOutputRewrite` | `true` |
| `contextAtToolBefore` | `false` |
| `contextAtToolAfter` | `true` |
| `contextAtStop` | `false` — the `stop` output schema carries `followup_message` and nothing else |
| `sessionStartContextReliable` | `false` — Cursor accepts `additional_context` at `sessionStart`, logs it as merged, and drops it (see [Lessons view](#lessons-view)) |
| `usageInPayload` | `true` |
| `effortSignal` | `false` |
| `thoughtEvent` | `true` |

## Policy defaults

`cursor.policy-defaults.ts` supplies the blocked-pattern list (`-fast(?:$|[^a-z0-9])`, `/fast(?:$|[^a-z0-9])`,
`composer-2\.5-fast`) — see [/decisions/ad-011.md](/decisions/ad-011.md).

**It supplies no model allowlist.** It used to, and an empty project list fell back to it, so a spawn could be
refused by five slugs that appear nowhere in the project and had already gone stale. `subagents.allowedModels` is
the operator's and has no other source; an empty one enforces nothing and `doctor` says so
([/decisions/ad-053.md](/decisions/ad-053.md)). The blocked patterns stay because they are **added** to the
project's rather than replacing them.

## Event mapping

`cursor.inbound.ts` maps Cursor's own camelCase hook names to the shared `HarnessEventKind`:

| Cursor hook | `HarnessEventKind` |
| --- | --- |
| `sessionStart` | `session.start` |
| `sessionEnd` | `session.end` |
| `beforeSubmitPrompt` | `prompt.submit` |
| `preToolUse` | `tool.before` |
| `postToolUse` | `tool.after` |
| `postToolUseFailure` | `tool.failure` |
| `beforeShellExecution` | `shell.before` |
| `afterShellExecution` | `shell.after` |
| `beforeMCPExecution` | `mcp.before` |
| `afterMCPExecution` | `mcp.after` |
| `beforeReadFile` | `read.before` |
| `afterFileEdit` | `edit.after` |
| `subagentStart` | `subagent.start` |
| `subagentStop` | `subagent.stop` |
| `stop` | `stop` |
| `preCompact` | `compact.before` |
| `afterAgentResponse` | `response.after` |
| `afterAgentThought` | `thought.after` |

Cursor has a dedicated event per tool class (`beforeShellExecution`, `beforeMCPExecution`,
`beforeReadFile`), unlike Claude's single `PreToolUse`/`PostToolUse` fan-out.

## Wiring target

`cursor.wiring.ts` writes (`strategy: "replace"`) the user-level `~/.cursor/hooks.json`, one entry per
`(hookEvent, handler)` pair, dispatching through the launcher: `node <launcherPath> <handler>` on
Unix/macOS, `cmd /c node <launcherPath> <handler>` on Windows. Handler names are the
`src/entrypoints/<name>.ts` filenames (see [/decisions/ad-015.md](/decisions/ad-015.md)):
`session-bootstrap`, `persist-handoff`, `obs-session-end`, `obs-passive`, `guard-subagent`,
`pre-tool-use`, `guard-shell`, `audit-event`, `guard-mcp`, `guard-read`, `format`, `verify-gates`,
`obs-stop`, `track-response`.

## Lessons view

`cursor.lessons-view.ts` renders `.tlc/harness/lessons.md` into `.cursor/rules/harness-lessons.mdc`
(`alwaysApply: true`). This is not a second copy of a working route — it is **the** route on this host. Cursor
accepts `additional_context` returned from `sessionStart`, logs it as merged, and drops it; its own staff called that
"a bug on our side… a timing issue between when the hook runs and when the composer handle is created" (forum thread
158452, 2026-04-20), and it was reported again against 3.14.7 on 2026-08-02. `env` on the same payload arrives,
because that is a different code path — which is why `HARNESS_ACTIVE` works while the prose does not.

The adapter therefore declares `sessionStartContextReliable: false`, and the default `syncRulesFile: "auto"` writes
the view here for that reason rather than because an operator guessed. `never` declines it; `always` forces it (see
[/decisions/ad-050.md](/decisions/ad-050.md), and [/decisions/ad-011.md](/decisions/ad-011.md) item 4 for the
original reasoning).

## Doctor / status

`tlc harness doctor` reports Cursor wiring as `wired`, `detected-but-unwired`, or `not-installed` by
diffing the live `~/.cursor/hooks.json` against the entries this adapter would write.

## See also

- [/providers/index.md](/providers/index.md)
- [/providers/claude-code.md](/providers/claude-code.md)
