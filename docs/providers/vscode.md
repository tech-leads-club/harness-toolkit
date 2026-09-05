---
type: Provider
title: "VS Code provider"
description: "The VS Code Agent Hooks adapter — hint-only detection, its capability descriptor, dual-casing inbound parse, and the wiring that is written and deliberately never dispatched."
tags: [provider, vscode]
timestamp: "2026-09-05"
---

# VS Code provider

Source: `src/providers/vscode/`. Registered as `vscode`.

**This adapter is complete and its wiring is never written.** Agent Hooks are Preview, so `install`, `doctor` and
`init` each take an explicit deferral branch ([/decisions/ad-126.md](/decisions/ad-126.md)). Everything below is
implemented and tested; only the dispatch is withheld.

## Detection

`vscode.detect.ts` returns true when `TLC_PROVIDER_HINT` is `vscode`, and false otherwise. There is no content
clause, and there cannot be one: VS Code emits Claude Code's payload byte for byte — same PascalCase
`hook_event_name`, same `session_id`, same `cwd`, same `tool_name` / `tool_input` pair. Any content test that
claimed a VS Code payload would claim every Claude payload too, and the registry would report ambiguity on all of
them.

The hint reaches the detector from the wiring: every entry launches
`node <launcher> --provider vscode <handler>`, and `bin/tlc-exec.mjs` turns that flag into
`TLC_PROVIDER_HINT` in the child environment. `resolveByHint` then resolves by name and runs no detector at all.

## Capability descriptor

`vscode.capabilities.ts`. Every value is cited in [/decisions/ad-125.md](/decisions/ad-125.md), which draws one
line and holds it: **what a hook receives** comes from GitHub's Copilot hooks reference, **what a hook may return
and have honoured** comes from VS Code's own pages. The Copilot reference's `modifiedArgs` and `modifiedResult`
belong to GitHub's CLI and cloud agent, so they settle nothing here.

VS Code has since published a per-event hooks reference
(<https://code.visualstudio.com/docs/agents/reference/hooks-reference>, read 2026-09-05). It documents
`updatedInput` on `PreToolUse` and `additionalContext` on `PreToolUse`, `PostToolUse`, `SessionStart` and
`SubagentStart`, which raises three flags that were `false` on the vendor's silence.

| Capability | Value |
| --- | --- |
| `enforcesHooks` | `true` |
| `askSupportedOn` | `["shell.before", "mcp.before", "read.before", "tool.before"]` — `PreToolUse` is the only event documented as returning `permissionDecision`, and those four are what it fans out to |
| `sessionEnv` | `false` — unmeasured; no environment is documented for a hook command |
| `nativeLoopCounter` | `false` — `stop_hook_active` is a boolean and the flag claims a count |
| `dedicatedShellEvent` | `false` — terminal execution is `PreToolUse` with `tool_name: "runTerminalCommand"` |
| `toolInputRewrite` | `true` — the published hooks reference documents `hookSpecificOutput.updatedInput` on `PreToolUse` |
| `toolOutputRewrite` | `false` — unmeasured; `modifiedResult` is the Copilot CLI's |
| `contextAtToolBefore` | `true` — `PreToolUse` is one of the four events the reference lists for `additionalContext` |
| `contextAtToolAfter` | `true` — `PostToolUse` is the second of those four |
| `contextAtStop` | `false` — `Stop` is not among them; its output is `decision` with a `reason` |
| `sessionStartContextReliable` | `true` — the VS Code page documents `hookSpecificOutput.additionalContext` on `SessionStart` |
| `toolOutputAtAfter` | `true` — `PostToolUse` carries `tool_result` |
| `usageInPayload` | `false` |
| `effortSignal` | `false` |
| `thoughtEvent` | `false` |

## Policy defaults

`vscode.policy-defaults.ts` names no untrusted tool and no blocked pattern. Neither source names a web tool in
the VS Code vocabulary — `web_fetch` and `web_search` are the Copilot CLI's, and `WebFetch` / `Fetch` are other
hosts' names for their own tools. A name invented here would match nothing, so the rail would look configured and
gate nothing.

## Event mapping

`vscode.inbound.ts`. VS Code's documented event list is eight events, three fewer than Claude's: there is no
`SessionEnd`, no `PostToolUseFailure` and no `MessageDisplay`.

| VS Code hook | Condition | `HarnessEventKind` |
| --- | --- | --- |
| `SessionStart` | — | `session.start` |
| `UserPromptSubmit` | — | `prompt.submit` |
| `PreToolUse` | `tool_name === "runTerminalCommand"` | `shell.before` |
| `PreToolUse` | `tool_name` matches `mcp_*` | `mcp.before` |
| `PreToolUse` | `tool_name` is `readFile` / `read_file` | `read.before` |
| `PreToolUse` | otherwise | `tool.before` |
| `PostToolUse` | `tool_name === "runTerminalCommand"` | `shell.after` |
| `PostToolUse` | `tool_name` matches `mcp_*` | `mcp.after` |
| `PostToolUse` | `tool_name` is `editFiles` / `createFile` / `create_file` / `replace_string_in_file` | `edit.after` |
| `PostToolUse` | otherwise | `tool.after` |
| `SubagentStart` | — | `subagent.start` |
| `SubagentStop` | — | `subagent.stop` |
| `Stop` | — | `stop` |
| `PreCompact` | — | `compact.before` |

An event name neither source lists returns `null`, and the run records `adapter.unrecognized` — the visible
failure rather than a near-enough kind delivered to rules written for another moment.

### Both spellings, because the vendor publishes both

GitHub's Copilot reference publishes every payload in two formats: a camelCase one, and one it labels
VS Code-compatible ("PascalCase with snake_case fields"). The parser reads both spellings of every envelope
field — `hook_event_name` / `hookEventName`, `session_id` / `sessionId`, `tool_name` / `toolName`,
`tool_input` / `toolArgs` — and the two formats of one payload produce the same event. This is the vendor's own
contract, not a hedge against Preview drift; the drift is the second reason, not the first.

The tool's output is read under three names for the same reason. GitHub's reference calls the `PostToolUse` field
`tool_result` with a `text_result_for_llm` inside it; VS Code's own reference calls it `tool_response`. Both are
read, the second serialised when it is not a string.

Two fields are deliberately not mapped. `stop_hook_active` never reaches `loopCount` — it is a boolean where the
grind cap reads a count, so mapping it in would leave the cap unreachable. `stop_reason` never reaches `status` —
it carries `"end_turn"`, which is not a member of the `completed | aborted | error` vocabulary.

## Outbound

`vscode.outbound.ts`:

- `allow`, `deny` and `ask` render `hookSpecificOutput.permissionDecision` with a `permissionDecisionReason`, on
  `PreToolUse` **only**. The reference states the pair is exclusive to that event, so the same object anywhere
  else is read by nothing. A refusal raised at another event is therefore dropped — recorded as a limitation
  below rather than routed through a channel that means something different.
- `context` rides `hookSpecificOutput.additionalContext` on the four events that accept it: `PreToolUse`,
  `PostToolUse`, `SessionStart` and `SubagentStart`. Anywhere else it renders nothing, because emitting into a
  field this host ignores would leave the caller believing it was delivered.
- `continue` emits `decision: "block"` with a `reason` — one pair in two placements. On `Stop` it sits inside
  `hookSpecificOutput` beside `hookEventName`; on `PostToolUse` and `SubagentStop` it is top-level. No other
  event documents a channel that hands text back and keeps the turn going, so elsewhere it renders nothing.
- `rewriteInput` emits `hookSpecificOutput.updatedInput` at `PreToolUse` and nothing elsewhere.

## Wiring target

`vscode.wiring.ts` describes `~/.copilot/hooks/tlc-harness.json`, `strategy: "replace"`, one entry per documented
event, each launching with `--provider vscode`. `renderVSCodeHooksText` produces the document and is asserted
against a golden file.

The document follows the published schema: each event maps to a **flat array of command objects**, with no group
wrapper, and `command` is a **single shell command line** rather than an argv array. Tokens carrying whitespace
are quoted. `timeout` is emitted per entry because the documented default is 30 seconds. No `matcher` is written —
quoted verbatim from the reference, "Currently, VS Code ignores matcher values, so hooks run on all tool
invocations regardless of the matcher", so writing one would read as a filter that is doing something.

```json
{ "hooks": { "PreToolUse": [{ "type": "command", "command": "node …/tlc-exec.mjs --provider vscode tool-before", "timeout": 10 }] } }
```

**Nothing writes it.** `applyProviderWiring` returns a `deferred` status, `providerWiringStatus` returns
`deferred` and doctor prints it as an `ok` row, and `init` names the workspace path in
`DEFERRED_PROJECT_SHIMS` without creating it. AD-126 rested on two facts and one of them is now settled: the file
shape is published, so the document is the vendor's rather than a guess. The other holds the deferral on its own —
Agent Hooks are Preview, and the reference says "The configuration format and behavior might change in future
releases" ([/decisions/ad-126.md](/decisions/ad-126.md)).

## Lessons view

`vscode.lessons-view.ts` appends a plain markdown pointer to `.github/copilot-instructions.md` naming
`.tlc/harness/lessons.md`. It is written under `intelligence.lessons.syncRulesFile: "always"` and **not** under
the default `"auto"`, because `sessionStartContextReliable` is `true` here.

The pointer is a sentence, not an `@path` import. Nothing in VS Code's or GitHub's documentation describes an
import syntax for that file, so an `@` line would be inert text dressed as a mechanism. Append-only and
idempotent: a second run is byte-identical, and a pointer the operator wrote in their own words is left alone.

## Known limitations

Three ways a rail on this host goes quiet, recorded in [/decisions/ad-125.md](/decisions/ad-125.md):

1. **VS Code reads `.claude/settings.json` by default.** With Claude hooks wired there — this harness writes
   them — VS Code loads them and runs them against its own payloads, where the tool name is
   `runTerminalCommand` rather than `Bash`. The Claude parser finds no tool it knows and produces a generic
   `tool.before`; every shell rule stops matching and nothing errors. `tlc harness doctor` reports this as a
   `warn` beside the VS Code row.
2. **A `!`-prefixed terminal input bypasses the tool hook**, so `shell.before` never sees it.
3. **A sandboxed auto-approve bypasses it too.**
4. **A refusal raised outside `PreToolUse` is dropped.** `permissionDecision` is exclusive to that event, and
   the events that carry `decision: "block"` carry a stop advisory rather than a permission verdict. In practice
   every rail that refuses runs at a before-kind, all four of which map to `PreToolUse`.

Neither bypass is a capability flag: `enforcesHooks` describes what happens when a hook runs, and these are the
cases where none does.

## See also

- [/providers/index.md](/providers/index.md)
- [/providers/claude-code.md](/providers/claude-code.md) — the payload shape this host reuses
- [/decisions/ad-125.md](/decisions/ad-125.md), [/decisions/ad-126.md](/decisions/ad-126.md)
