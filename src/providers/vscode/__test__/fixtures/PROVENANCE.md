# VS Code fixtures — provenance

**These payloads are documentation-derived, not captured.** No VS Code process produced them. A later capture
upgrades any file here without changing the adapter.

| Source | Read on |
| --- | --- |
| Agent hooks in Visual Studio Code (Preview) — <https://code.visualstudio.com/docs/agent-customization/hooks> | 2026-09-04 |
| GitHub Copilot hooks reference — <https://docs.github.com/en/copilot/reference/hooks-reference> | 2026-09-04 |

Two sources are needed because they cover different halves. The VS Code page gives the event list, the hook
configuration file shape, the discovery locations, and the exit-code contract, but states the common stdin fields
only (`timestamp`, `cwd`, `session_id`, `hook_event_name`, `transcript_path`) and does not inline per-event
payloads. The Copilot reference gives the per-event payloads, and gives them in **two formats**: a camelCase one
and one it labels VS Code-compatible, "PascalCase with snake_case fields". Every fixture here except
`pre-tool-use-terminal-camel.json` is the VS Code-compatible format.

That two-format documentation is the citation behind the dual-casing requirement in design §5 and task T16. The
requirement is not a guess about payload drift — the vendor documents both spellings.

## Files

| Fixture | Event | Format | Kind |
| --- | --- | --- | --- |
| `session-start.json` | `SessionStart` — `session_id`, `timestamp`, `cwd`, `source`, `initial_prompt?` | VS Code-compatible | documentation-derived |
| `user-prompt-submit.json` | `UserPromptSubmit` — `session_id`, `timestamp`, `cwd`, `prompt` | VS Code-compatible | documentation-derived |
| `pre-tool-use-terminal.json` | `PreToolUse` — `session_id`, `timestamp`, `cwd`, `tool_name`, `tool_input` | VS Code-compatible | documentation-derived |
| `pre-tool-use-terminal-camel.json` | the same event, camelCase — `sessionId`, `toolName`, `toolArgs` | camelCase | documentation-derived |
| `pre-tool-use-read.json` | `PreToolUse`, `tool_name: "readFile"` | VS Code-compatible | documentation-derived |
| `pre-tool-use-read-snake.json` | `PreToolUse`, `tool_name: "read_file"` | VS Code-compatible | documentation-derived |
| `pre-tool-use-edit.json` | `PreToolUse`, `tool_name: "editFiles"` | VS Code-compatible | documentation-derived |
| `pre-tool-use-mcp.json` | `PreToolUse`, `tool_name: "mcp_github_create_issue"` | VS Code-compatible | documentation-derived |
| `pre-tool-use-unknown.json` | `PreToolUse`, `tool_name: "pushToGitHub"` — falls through to the generic kind | VS Code-compatible | documentation-derived |
| `post-tool-use-terminal.json` | `PostToolUse` — adds `tool_result: { result_type, text_result_for_llm }` | VS Code-compatible | documentation-derived |
| `post-tool-use-edit.json` | `PostToolUse`, `tool_name: "replace_string_in_file"` | VS Code-compatible | documentation-derived |
| `post-tool-use-create.json` | `PostToolUse`, `tool_name: "createFile"` | VS Code-compatible | documentation-derived |
| `pre-compact.json` | `PreCompact` — `transcript_path`, `trigger`, `custom_instructions` | VS Code-compatible | documentation-derived |
| `subagent-start.json` | `SubagentStart` — `agent_name`, `agent_display_name?`, `agent_description?` | VS Code-compatible | documentation-derived |
| `subagent-stop.json` | `SubagentStop` — `agent_id`, `agent_type`, `agent_name`, `last_assistant_message`, `stop_reason` | VS Code-compatible | documentation-derived |
| `stop.json` | `Stop` — `stop_reason`, `stop_hook_active` | VS Code-compatible | documentation-derived |
| `unknown-event.json` | — | synthetic; an event name neither source lists | synthetic |

## Two things worth pinning

**`SubagentStart` types `timestamp` as a number** in the reference while every other event types it as an ISO 8601
string. The fixture reproduces the string form the surrounding events use, because a lone numeric `timestamp`
reads as a documentation slip rather than a real shape, and it is the only field where the reference contradicts
itself. This is the one place a fixture here departs from the letter of the source; it is recorded rather than
silently smoothed. A capture settles it.

**Nothing here fingerprints VS Code.** `pre-tool-use-terminal.json` is byte-shaped exactly like a Claude Code
`PreToolUse` — same `hook_event_name`, same `session_id`, same `cwd`, same `tool_name` / `tool_input` pair. That
collision is the reason detection is hint-only — AD-003 in the feature's own decision log, `.specs/STATE.md`,
numbered independently from the shipped `docs/decisions/` records — and these fixtures are the evidence for it:
T15 asserts the detector returns false for every one of them absent the hint, including this one.

## Tool names

The VS Code page names `runTerminalCommand`, `editFiles`, `createFile`, `deleteFile`, `pushToGitHub`,
`create_file`, and `replace_string_in_file` in its examples. The Copilot reference names a different set for its
own CLI (`bash`, `create`, `view`, `edit`, `grep`, `glob`, `web_fetch`, `web_search`, `ask_user`, `update_todo`,
`task`). The fan-out in design §5 is written against the **VS Code** vocabulary; the CLI's set is a different
product's and is not mapped here.

Neither source enumerates the mcp tool-name form. `mcp_github_create_issue` follows the single-underscore `mcp_`
prefix design §5 records for this host, which is not the double-underscore `mcp__` Codex uses. That prefix is the
least-evidenced value in this directory and is the first thing a capture should confirm.

## What these fixtures cannot settle

A fixture proves the shape a host sends, never what it does with a field it accepts back
(`src/contracts/capabilities.ts:14`). VS Code's capability flags are settled in its own decision record under T2,
with the conservative value wherever documentation is silent.
