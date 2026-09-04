# Codex fixtures — provenance

**These payloads are documentation-derived, not captured.** No Codex process produced them. Every field below was
read off OpenAI's published hook reference; nothing was invented, and nothing was carried over by analogy to
Claude Code or Cursor. A later capture from a running Codex upgrades any file here without changing the adapter —
replace the file, change its row's kind to `captured`, and note the Codex version.

| Source | Read on |
| --- | --- |
| OpenAI Codex hooks reference — <https://learn.chatgpt.com/docs/hooks> | 2026-09-04 |

## Files

| Fixture | Event | Fields taken from | Kind |
| --- | --- | --- | --- |
| `session-start.json` | `SessionStart` | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source` | documentation-derived |
| `session-end.json` | `SessionEnd` | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `reason` | documentation-derived |
| `subagent-start.json` | `SubagentStart` | `session_id`, `cwd`, `hook_event_name`, `turn_id`, `agent_id`, `agent_type`, `permission_mode` | documentation-derived |
| `user-prompt-submit.json` | `UserPromptSubmit` | `session_id`, `cwd`, `hook_event_name`, `turn_id`, `prompt`, `permission_mode` | documentation-derived |
| `pre-tool-use-bash.json` | `PreToolUse` | `session_id`, `cwd`, `hook_event_name`, `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `permission_mode` | documentation-derived |
| `pre-tool-use-apply-patch.json` | `PreToolUse` | same | documentation-derived |
| `pre-tool-use-mcp.json` | `PreToolUse` | same | documentation-derived |
| `permission-request-bash.json` | `PermissionRequest` | `session_id`, `cwd`, `hook_event_name`, `turn_id`, `tool_name`, `tool_input`, `tool_input.description`, `permission_mode` | documentation-derived |
| `post-tool-use-bash.json` | `PostToolUse` | `session_id`, `cwd`, `hook_event_name`, `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response`, `permission_mode` | documentation-derived |
| `post-tool-use-apply-patch.json` | `PostToolUse` | same | documentation-derived |
| `post-tool-use-mcp.json` | `PostToolUse` | same | documentation-derived |
| `pre-compact.json` | `PreCompact` | `session_id`, `cwd`, `hook_event_name`, `turn_id`, `trigger` | documentation-derived |
| `post-compact.json` | `PostCompact` | same | documentation-derived |
| `subagent-stop.json` | `SubagentStop` | `session_id`, `cwd`, `hook_event_name`, `turn_id`, `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, `last_assistant_message`, `permission_mode` | documentation-derived |
| `stop.json` | `Stop` | `session_id`, `cwd`, `hook_event_name`, `turn_id`, `stop_hook_active`, `last_assistant_message`, `permission_mode` | documentation-derived |
| `stop-loop-active.json` | `Stop` | same, with `stop_hook_active: true` | documentation-derived |
| `interrupt.json` | `Interrupt` | `session_id`, `cwd`, `hook_event_name`, `turn_id`, `permission_mode` | documentation-derived |
| `unknown-event.json` | — | synthetic; carries a `hook_event_name` the reference does not list, to prove the parser refuses it | synthetic |

The reference documents twelve events: `SessionStart`, `SessionEnd`, `SubagentStart`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`,
`Interrupt`.

## Values chosen inside a documented field

The reference gives field *names* and types, not example values, so the values below are the fixture author's and
carry no evidentiary weight. Only the shapes do.

- `tool_input.command` on `pre-tool-use-apply-patch.json` and `post-tool-use-apply-patch.json` holds **patch text**,
  not a shell command. That is the point of the fixture: it is the payload that makes `apply_patch` map to the
  generic `tool.before` / `tool.after` kinds rather than to `shell.*` (design §5), and a mapping that sends it to
  shell would feed a patch body to shell-command rules.
- `tool_name` is `mcp__github__create_issue` on the mcp fixtures — the double-underscore prefix, which is Codex's
  form and not VS Code's single-underscore `mcp_`.
- `permission_mode` is `"on-request"` throughout. The reference types it as a string without enumerating values.

## Correction to AD-123, item 1

`docs/decisions/ad-123.md` states that Codex has no `SessionEnd` event and that a wiring rule capping its timeout
would be a rule about an event the host never fires. **That is wrong.** The reference documents `SessionEnd` under
its own heading, and documents the timeout rule the transcription had recorded:

> `timeout` is in seconds. If omitted, Codex uses 600 seconds for most hooks. `SessionEnd` and `Interrupt` use 1
> second by default and support up to 3 seconds.

So the transcription's "SessionEnd timeout is capped at 3s" was accurate, and the correction that overturned it was
the error. `Interrupt` is likewise a real event AD-123's list omits. AD-123's remaining three corrections
(`PermissionRequest` vocabulary, the nested `hooks.json` shape, `stop_hook_active`) are unaffected and stand.

This changes the acceptance criterion on task T13, which currently requires that no wiring entry name a
`SessionEnd` event. Both the record and that criterion are amended in T2, whose file `docs/decisions/ad-123.md` is.

## What these fixtures cannot settle

A fixture proves the shape a host **sends**. It cannot prove what a host **does** with a field it accepts back —
`src/contracts/capabilities.ts:14`. Flags in that class take the conservative value in AD-123 and are marked
unmeasured there; no fixture here should be read as evidence for one.
