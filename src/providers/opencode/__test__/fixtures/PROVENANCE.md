# opencode fixtures — provenance

opencode differs from the other two hosts in a way that changes what a fixture here even means. Codex and VS Code
pipe their own payload to the launcher, so a fixture is a vendor artefact. opencode does not: it loads a **plugin
module this harness writes**, and that bridge decides what to put on the launcher's stdin. Every file here is
therefore two things at once — a vendor part, whose field names come from opencode's plugin reference, and an
envelope this project defines.

Both parts are labelled below. The envelope is not evidence about opencode; it is a decision this task pins so
that T5 (detect), T7 (inbound), and T8 (the two bridge plugins) agree on one shape instead of each inventing one.

| Source | Read on |
| --- | --- |
| opencode plugins (legacy plugin API) — <https://opencode.ai/docs/plugins> | 2026-09-04 |
| opencode plugins (namespaced plugin API) — <https://opencode.ai/v2/docs/build/plugins> | 2026-09-04 |

Two directories because opencode registers twice, once per plugin API generation — AD-007 in the feature's own
decision log, `.specs/STATE.md`, which is numbered independently from the shipped `docs/decisions/` records.
`legacy/` is the flat hook-key API; `namespaced/` is `Plugin.define({ id, setup })` with `ctx.<domain>.hook(...)`.

## The envelope — harness-defined, not vendor-derived

Every fixture in both directories carries these four keys, stamped by the bridge:

| Key | Value | Why it exists |
| --- | --- | --- |
| `provider` | `"opencode"` | The marker `opencode.detect.ts` checks (design §4). |
| `pluginApi` | `"legacy"` \| `"namespaced"` | The generation marker. The two detectors are mutually exclusive on it, which is what stops `resolveFromRegistry` reporting `ambiguous` with both adapters registered. |
| `hook` | the hook key, e.g. `"tool.execute.before"` | The legacy API's own key spelling; for the namespaced API, the domain and hook name joined, since `ctx.tool.hook("execute.before")` has no single documented string form. |
| `sessionID` | opaque string | opencode's own spelling — the reference's examples read `input.sessionID`, not `session_id`. |

The envelope is belt to the hint channel's braces: each bridge also launches with `--provider <its adapter name>`,
so routing is normally settled before any detector runs, per AD-003 in that same feature log. The markers are
what keeps a hand-copied bridge from resolving to the wrong descriptor.

## Vendor-derived fields

The reference documents the tool hooks by example rather than by type signature. What it actually shows is
`input.tool`, `input.sessionID`, `input.args.command`, `input.args.filePath`, and `output.args` — and that a
`throw` from `tool.execute.before` blocks execution. **Every fixture field outside the envelope is one of those.**
Fields the reference does not show are absent here rather than guessed, which is why these payloads are thinner
than the Codex and VS Code ones.

### `legacy/`

| Fixture | `hook` | `tool` | Maps to (design §5) |
| --- | --- | --- | --- |
| `tool-execute-before-bash.json` | `tool.execute.before` | `bash` | `shell.before` |
| `tool-execute-before-read.json` | `tool.execute.before` | `read` | `read.before` |
| `tool-execute-before-edit.json` | `tool.execute.before` | `edit` | `tool.before` — the edit row of the fan-out table is an *after* kind |
| `tool-execute-before-mcp.json` | `tool.execute.before` | `mcp_github_create_issue` | `mcp.before` |
| `tool-execute-before-unknown.json` | `tool.execute.before` | `todowrite` | `tool.before` |
| `tool-execute-after-bash.json` | `tool.execute.after` | `bash` | `shell.after` |
| `tool-execute-after-write.json` | `tool.execute.after` | `write` | `edit.after` |
| `tool-execute-after-patch.json` | `tool.execute.after` | `patch` | `edit.after` |

### `namespaced/`

Adds the two hooks that are the whole reason for the split — they have no legacy counterpart:

| Fixture | `hook` | Carries | Why it matters |
| --- | --- | --- | --- |
| `permission-evaluate.json` | `permission.evaluate` | `effect`, `message` | `ctx.permission.hook("evaluate")` takes `effect: "allow" \| "ask" \| "deny"`. A genuine ask channel, which the legacy API has none of — this is the citation behind the namespaced descriptor's non-empty `askSupportedOn`. |
| `shell-create-before.json` | `shell.create.before` | `command`, `cwd`, `timeout`, `shell`, `env` | `ctx.shell.hook("create.before")` — shell interception separate from tool execution, so `dedicatedShellEvent` is true here and false on legacy. |

`tool-execute-after-bash.json` and `tool-execute-after-error.json` carry `status`, which the namespaced reference
documents as `"completed" | "error"` on `execute.after`. The legacy `after` fixtures carry no status field because
the legacy reference documents none.

## The gap this task did not close

**`tool.execute.after`'s output shape is undocumented on both generations.** The legacy reference shows an example
for `before` only; one third-party reference states `after` takes no `output` parameter at all. The namespaced
reference says `execute.after` inspects results without showing the object.

That directly touches a flag design §7 currently pins as `toolOutputRewrite: true` for both generations, on the
strength of the transcription alone. Under AD-005 a measured behaviour recorded in the transcription is acceptable
provenance, so the flag is not blocked — but it is the weakest value in the opencode table, it has no documentary
corroboration, and T2's record must say so rather than presenting it as settled. The same absence is why no
fixture here models a rewritten tool output.

Two smaller gaps, recorded rather than filled: opencode's session-lifecycle events (`session.created`,
`session.idle`, `session.compacted`, `permission.asked`) appear in the documented event list with **no payload
shapes**, so this directory covers the dispatcher hooks only, which is the bar T1 sets. And the `mcp_` prefix in
the fan-out table is design §5's, not the reference's — no source read here enumerates opencode's mcp tool-name
form.

## What these fixtures cannot settle

A fixture proves the shape the bridge sends. It cannot prove what opencode does with a value the bridge returns —
`src/contracts/capabilities.ts:14`. The two capability descriptors are settled in T2's record, conservatively
wherever documentation is silent.
