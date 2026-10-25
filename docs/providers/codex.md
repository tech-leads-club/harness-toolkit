---
type: Provider
title: "Codex provider"
description: "Codex local lifecycle hooks, explicit provider routing, installation, and compatibility limits."
tags: [provider, codex]
timestamp: "2026-10-24"
---

# Codex provider

Source: `src/providers/codex/`. Implements the local command-hook contract documented in
[OpenAI's hooks reference](https://learn.chatgpt.com/docs/hooks).

## Installation and trust

Run `tlc harness install` with Node 24+ available to Codex. An existing `CODEX_HOME` directory (default
`~/.codex`) is detected, the init skill is linked, and harness handlers are merged into `hooks.json`.
Existing foreign handlers and metadata are preserved. Malformed documents are refused without writing.
The installer does not edit `config.toml`, enable disabled hooks, or grant hook trust.

Restart Codex and review the new definitions with `/hooks`. Changed definitions require a new trust review.
`tlc harness doctor` verifies the file registration; it cannot verify Codex's enabled or trusted state.
`tlc harness uninstall` removes only this adapter's handlers and the installed skill link.

This adapter targets locally orchestrated Codex sessions with the documented lifecycle hooks. It is not
an integration with cloud orchestration. Validate it in your Codex version before depending on a gate.

## Detection

The generated command passes `--provider codex` to `tlc-exec.mjs`. The launcher tags the stdin payload
with `_tlc_provider: "codex"` before dispatch. This is routing metadata, not authentication. Shared
PascalCase event names and `cwd` cannot distinguish Codex from Claude Code; untagged payloads retain
the existing provider detection behavior. Sessions use the `codex-` state namespace.

## Capability descriptor

<!-- generated:capabilities -->

| Capability | Value |
|---|---|
| `enforcesHooks` | `true` |
| `askSupportedOn` | `[]` |
| `sessionEnv` | `false` |
| `nativeLoopCounter` | `false` |
| `dedicatedShellEvent` | `false` |
| `toolInputRewrite` | `true` |
| `toolOutputRewriteOn` | `[]` |
| `contextAtToolBefore` | `true` |
| `contextAtToolAfter` | `true` |
| `contextAtStop` | `false` |
| `sessionStartContextReliable` | `true` |
| `toolOutputAtAfter` | `true` |
| `usageInPayload` | `false` |
| `effortSignal` | `false` |
| `thoughtEvent` | `false` |

<!-- /generated -->

## Policy defaults

No provider-specific model blocklist or minimum effort. No hosted-search tool is declared as observed:
Codex does not send hosted tool calls through these hooks.

## Event mapping

<!-- generated:event-mapping -->

| Hook | Fan-out rule | HarnessEventKind |
|---|---|---|
| `SessionStart` | — | `session.start` |
| `SessionEnd` | — | `session.end` |
| `UserPromptSubmit` | — | `prompt.submit` |
| `SubagentStart` | — | `subagent.start` |
| `SubagentStop` | — | `subagent.stop` |
| `Stop` | — | `stop` |
| `PreCompact` | — | `compact.before` |
| `PreToolUse` | tool_name === "Bash" | `shell.before` |
| `PreToolUse` | tool_name matches `^mcp__` | `mcp.before` |
| `PostToolUse` | tool_name === "Bash" | `shell.after` |
| `PostToolUse` | tool_name matches `^mcp__` | `mcp.after` |
| `PostToolUse` | tool_name === "apply_patch" | `edit.after` |

<!-- /generated -->

Unlisted tool names use `tool.before`/`tool.after`. `apply_patch` becomes an `Edit` with every affected
absolute path, including move destinations. The dispatcher evaluates each path and refuses the entire
call on a blocking verdict. Post-edit presence records cover every path. Patch fragments are not treated
as full proposed file content, so before-edit comment checks are unavailable; stop-time diff checks remain.

`spawn_agent` becomes `Task` for the pre-spawn checks. Subagent lifecycle events carry the declared type
and agent id; they do not invent a child model or caller identity absent from the payload.
`Stop.last_assistant_message` is processed for structured claims before stop gates run. There is no
intermediate response event, so plan declarations in earlier assistant messages are not observed.

## Wiring target

Merged `CODEX_HOME/hooks.json`, with shell command strings, explicit timeouts, and a PowerShell
`commandWindows` override. Both user hook configuration paths are protected from agent edits.
Session-end work has Codex's three-second maximum timeout. Gate checks use 120 seconds.

## Limits

- Unsupported `ask` decisions become denials. The adapter never silently converts a request into approval.
- Stop continuation uses `decision: "block"`; advisory context at Stop is unavailable.
- Output replacement is unavailable. Secret-output checks can add a notice but cannot erase returned text.
- Subagent-start hooks cannot refuse a child that already started; their refusals surface as a system message.
  Enforcement is at the pre-spawn tool hook where available.
- No usage accounting, stable transcript parser, thought event, effort signal, or dedicated tool-failure event.
  Failed Bash commands still arrive through PostToolUse.
- Hook errors/timeouts can fail open in Codex. Hosted tools, specialized bypass paths, and subsequent stdin
  writes to an approved interactive shell are outside complete interception. This is not a security sandbox.

## See also

- [/providers/index.md](/providers/index.md)
