---
type: Provider
title: "Claude Code provider"
description: "The Claude Code adapter — capability descriptor, event mapping, and wiring target for the settings.json hooks block in Claude Code's resolved config directory."
tags: [provider, claude-code]
timestamp: "2026-07-29"
---

# Claude Code provider

Source: `src/providers/claude/`.

## Detection

`claude.detect.ts`: a raw hook payload is Claude Code's when `hook_event_name` is PascalCase (e.g.
`PreToolUse`) and either `cwd` or `transcript_path` is present.

## Capability descriptor

`claude.capabilities.ts`:

| Capability | Value |
| --- | --- |
| `enforcesHooks` | `true` |
| `askSupportedOn` | `["tool.before", "shell.before", "mcp.before", "read.before"]` — includes `tool.before`, unlike Cursor (see [/decisions/ad-009.md](/decisions/ad-009.md), note) |
| `sessionEnv` | `false` |
| `nativeLoopCounter` | `false` — `Stop` carries no loop counter; `core/turn` supplies it instead (see [/decisions/ad-014.md](/decisions/ad-014.md)) |
| `dedicatedShellEvent` | `false` — shell is `PreToolUse`/`PostToolUse` with `tool_name: "Bash"` |
| `toolInputRewrite` | `true` |
| `toolOutputRewrite` | `true` |
| `contextAtToolBefore` | `true` |
| `contextAtToolAfter` | `true` |
| `contextAtStop` | `true` — `Stop` accepts `hookSpecificOutput.additionalContext` for feedback that continues the turn |
| `sessionStartContextReliable` | `true` — `SessionStart` delivers `hookSpecificOutput.additionalContext`, capped at 10,000 characters |
| `usageInPayload` | `false` — cost comes from the transcript, not the hook payload |
| `effortSignal` | `true` — `effort.level` (`low\|medium\|high\|xhigh\|max`) |
| `thoughtEvent` | `false` |

## Policy defaults

`claude.policy-defaults.ts` supplies no model allowlist and no blocked patterns — see
[/decisions/ad-011.md](/decisions/ad-011.md).

It used to ship three model slugs, and an empty project list fell back to them, so a spawn could be refused by a
list that appears nowhere in the project. This page named a fourth that the code did not, which is what a shipped
catalogue does over time. `subagents.allowedModels` is the operator's and has no other source; an empty one
enforces nothing and `doctor` says so ([/decisions/ad-053.md](/decisions/ad-053.md)).

## Event mapping

`claude.inbound.ts` maps Claude's PascalCase hook names to `HarnessEventKind`. Unlike Cursor, `PreToolUse`
and `PostToolUse` are single dispatcher hooks that fan out by `tool_name`:

| Claude hook | Fan-out rule | `HarnessEventKind` |
| --- | --- | --- |
| `SessionStart` | — | `session.start` |
| `SessionEnd` | — | `session.end` |
| `UserPromptSubmit` | — | `prompt.submit` |
| `PreToolUse` | `tool_name === "Bash"` | `shell.before` |
| `PreToolUse` | `tool_name` matches `mcp__*` | `mcp.before` |
| `PreToolUse` | `tool_name === "Read"` | `read.before` |
| `PreToolUse` | otherwise | `tool.before` |
| `PostToolUse` | `tool_name === "Bash"` | `shell.after` |
| `PostToolUse` | `tool_name` matches `mcp__*` | `mcp.after` |
| `PostToolUse` | `tool_name` is `Edit`/`Write` | `edit.after` |
| `PostToolUse` | otherwise | `tool.after` |
| `PostToolUseFailure` | — | `tool.failure` |
| `SubagentStart` | — | `subagent.start` |
| `SubagentStop` | — | `subagent.stop` |
| `Stop` | — | `stop` |
| `PreCompact` | — | `compact.before` |
| `MessageDisplay` | — | `response.after` |

Claude has no `thought.after` equivalent (`thoughtEvent: false`).

## Field paths

Exact JSON field paths this adapter reads are pinned in
[/decisions/ad-014.md](/decisions/ad-014.md) — including the one inferred rather than documented
(`tool_input.file_path` for Edit/Write/Read).

## Wiring target

`claude.wiring.ts` merges (`strategy: "merge"`) into `~/.claude/settings.json`'s `hooks` block —
never replacing the file wholesale, since a user's own Claude settings may already exist. Every entry uses
exec form (`command: "node"`, `args: [launcherPath, handler]`) on every platform, bypassing shell
tokenization so there is no quoting variant to get wrong. Handler names are the
`src/entrypoints/<name>.ts` filenames (see [/decisions/ad-015.md](/decisions/ad-015.md)):
`session-start`, `session-end`, `prompt-submit`, `tool-before`, `tool-after`, `tool-failure`,
`subagent-start`, `subagent-stop`, `stop`, `compact-before`, `response-after`.

The merge is idempotent and deep-equality-checked per hook group, so re-running it never duplicates an
already-present entry.

## Lessons view

`claude.lessons-view.ts` appends a single `@.tlc/harness/lessons.md` import line to the project's `CLAUDE.md` when it
is not already present. It is a pointer, not a copy — the content lives in one file.

It is written under `intelligence.lessons.syncRulesFile: "always"` and **not** under the default `"auto"`, because
this adapter declares `sessionStartContextReliable: true`: `SessionStart` delivers
`hookSpecificOutput.additionalContext`, so lessons arrive without a durable file and the pointer would be a second
copy of a working route. Set `always` to have it anyway — it survives a restart, which the injected context does not
(see [/decisions/ad-050.md](/decisions/ad-050.md), and [/decisions/ad-011.md](/decisions/ad-011.md) item 4).

Only `hookSpecificOutput.additionalContext` is emitted. Claude Code reads a top-level `additional_context` as well
and does not deduplicate the two, so emitting both would inject the same text twice.

## Doctor / status

`tlc harness doctor` reports Claude wiring as `wired` when merging the current entries into the existing
`~/.claude/settings.json` would produce no change, `detected-but-unwired` otherwise, and `not-installed`
when `~/.claude` does not exist.

## See also

- [/providers/index.md](/providers/index.md)
- [/providers/cursor.md](/providers/cursor.md)
