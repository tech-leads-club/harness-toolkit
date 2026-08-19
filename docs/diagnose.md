---
type: Runbook
title: "Diagnose"
description: "Checklist for hooks not firing, Node vs Bun runtime confusion, stale runtime, subagent denials, cost showing null, and double hooks — for both Cursor and Claude Code."
tags: [runbook, diagnose, troubleshooting]
timestamp: "2026-07-29"
---

# Diagnose

Run `tlc harness doctor` first. Then walk this checklist.

## Hooks not firing

**Cursor**

1. Confirm the Cursor config directory's `hooks.json` invokes `node …/tlc-exec.mjs <handler>` (installers
   write this). `tlc harness doctor` prints the resolved path; `CURSOR_CONFIG_DIR` overrides the default.
2. `dist/*.mjs` must exist (`tlc harness build`).
3. Reload Cursor after editing hooks.
4. Open **View → Output → Hooks** for exit errors.
5. Project shim should call `tlc-exec shim <handler>`; with the global `sessionStart` hook set,
   `TLC_ACTIVE=1` makes the shim no-op (expected).

**Claude Code**

1. Confirm the Claude config directory's `settings.json` (resolved, `CLAUDE_CONFIG_DIR` overrides the
   default) has a `hooks` block with entries whose `command` is `node` and whose
   `args` start with the launcher path (see [/providers/claude-code.md](/providers/claude-code.md)).
2. `dist/*.mjs` must exist (`tlc harness build`).
3. Restart the Claude Code session after editing `settings.json`.
4. Project shim should call `tlc-exec shim <handler>`.

On Windows, Cursor hooks use `cmd /c node "…\tlc-exec.mjs" …`; Claude Code hooks stay exec-form
(`node …`) on every platform.

## Node vs Bun

- Preferred: **Bun** on PATH — every hook runs the TypeScript source directly, ~1 ms per invocation.
- Guaranteed fallback: **Node 24+** + `tlc harness build` (`dist/*.mjs`), ~27 ms per invocation.
- `tlc harness doctor` reports the resolved runtime as `OK` (Bun found) or `WARN` (Node fallback, with the
  measured cost of the gap and the one-line fix). See [/decisions/ad-012.md](/decisions/ad-012.md).
- Missing dist with Node present: run `tlc harness build` (needs Bun or esbuild once to compile).

## `update` aborts on `dist/` and keeps aborting

The one manual step, once, on every platform:

```bash
npm i -g @tech-leads-club/harness-toolkit@latest
tlc harness install
```

**Why it has to be that and not `update`.** `update` runs from the installed runtime, and the fix for `update` is in
the revision `update` has to fetch — so a stuck install cannot deliver its own fix. The registry serves the package
independently of what is installed, which makes it the only route that does not depend on the thing that is stuck
([/decisions/ad-048.md](/decisions/ad-048.md)).

Installing over a managed checkout moves it to `origin/main` with a hard reset. `config.json` and `state/` are gitignored,
so your policy, global lessons and obs history survive it. A **linked** runtime — a symlink to your own clone — is
left completely alone.

There is no `--force`: a managed runtime is already reset, and a linked clone is never written to.

## Stale runtime / need latest main

```bash
tlc harness update
```

Then reload/restart the provider session.

**What update may write depends on what the runtime path is.** `tlc harness doctor` prints it as
`runtime ownership` ([/decisions/ad-046.md](/decisions/ad-046.md)):

| Kind | What update does |
| --- | --- |
| `managed checkout` | fetches and moves it to upstream with a hard reset — the harness owns its contents, so a local change there is never yours |
| `link to a working clone` | **nothing** in the clone. Refreshes only the CLI link, the skill link and provider hooks. Pull that clone yourself |
| `installed from npm` | bumps the package to `@latest` and re-materialises the runtime. No git command runs against it |
| `not a git checkout` | nothing to pull — install the package and run `tlc harness install` |

Update never rebuilds `dist/` when every bundle is present. It used to, and because Bun and esbuild emit different
bytes for the same source, the rebuild left the checkout permanently dirty and every later update failed. If you see
`update: dist/ complete — no rebuild`, that is the fix working.

After update, `tlc harness doctor` reports non-blocking `WARN:` lines for off/missing opt-ins (and for
default-on features you explicitly set to `false`). They do not fail doctor by themselves. A missing
`.tlc/harness/config.json` still fails the project-policy check until you init.

## `tlc: command not found`

Re-run the platform installer, or ensure the CLI shim is on PATH:

- Unix: `~/.local/bin/tlc` → `~/.tlc/harness/bin/tlc`
- Windows: `%USERPROFILE%\.local\bin\tlc.cmd`

## Obs empty / no signal

1. `observability.enabled` must not be `false` in config.
2. Happy-path tool/shell events are **debug** — enable `debugEnabled` or look for signal kinds only.
3. Confirm `.tlc/harness/state/` is writable in the project.
4. `tlc harness obs live` after a prompt submit / stop / denial.

## The floor blocked a command that only reads harness state

Reading is ordinary work and the bootstrap asks for it, so a refusal there means the *verb* could not be proven to
only read — not that reading is forbidden. The refusal now says so and names the way through
([/decisions/ad-047.md](/decisions/ad-047.md)):

```bash
tlc harness handoff          # handoff state, no shell needed
tlc harness policy           # the resolved policy
tlc harness handoff --json   # same, for a script
```

Proven readers on the policy surface: `cat`, `head`, `tail`, `less`, `more`, `grep`, `rg`, `jq`, `ls`, `stat`,
`file`, `wc`, `cmp`, `diff`, `od`, `xxd`, `strings`, `md5sum`, `sha256sum`, `echo`, `printf`, `test`, `[`, and
`git show|diff|log|status|ls-files|cat-file|blame`.

`awk` and `sort` are **not** readers, on purpose — `awk '{print > f}'` and `sort -o f` write a file the head verb
never reveals. A redirect onto the surface is denied whatever the verb, so `test -f x > config.json` still fails.

## The gate runs on a turn that changed nothing

It does not any more, and this is how to confirm it. A verdict is keyed on a content hash of the gate command and
the files it ran against; a match reuses the verdict without executing the command
([/decisions/ad-045.md](/decisions/ad-045.md)).

```bash
tlc harness obs report      # the Gate time table has a Reused column
```

| Reading | Meaning |
| --- | --- |
| `Runs` climbing on every turn | the inputs really are changing, or the hash is incomplete |
| `Reused` climbing | the verdict stood and the command did not run |
| both zero | the gate never ran; check `grind.enabled` and `codePaths` |

The hash is **incomplete** — so the gate always runs — when an input cannot be read, which includes a tracked file
that was deleted, or when the changed set exceeds 400 files or 12 MB. A gate that depends on something outside the
changed files (a database, a service, an environment variable) can also reuse a verdict that no longer holds.

## A lesson is not reaching the turn

`tlc harness lessons list` answers it directly — a lesson that is being withheld is marked `WITHHELD` and the
notes on its line say why.

| Note | Meaning | What to do |
| --- | --- | --- |
| `stale=path-missing` / `symbol-missing` | a `--ref` no longer resolves | restore or rename the ref, then `tlc harness lessons garden` |
| `validity=expired` | past its `--until` | the next garden prunes it; write a new one |
| `validity=pending` | its window has not opened | wait, or rewrite without `--from` |
| `validity=invalid` | an unparseable bound, so it fails closed | rewrite with an ISO date |
| `WITHHELD` with no note | a **global** lesson whose refs do not resolve in this repository | expected — it applies where it came from |

Nothing withheld and still absent? Then it lost on rank or budget, not on health:

1. `enabled=true` on the last line of `lessons list`.
2. `status` must be `active` for session injection; a `candidate` only shows on a matching retry.
3. **The budget usually binds.** `maxCharsSession` defaults to 900 and fits about two blocks while
   `maxInjectSession` says five. The injected block names what it dropped; raising `maxCharsSession` is the fix.
4. **A rule you consider non-negotiable should be pinned, not ranked** — `lessons add … --pin` puts it ahead of
   every scored lesson ([/decisions/ad-043.md](/decisions/ad-043.md)).

`tlc harness doctor` carries the same facts as one row (`lesson health`), and warns separately about stale,
out-of-window and unproven lessons. See [/lessons.md](/lessons.md).

## Two agents in one checkout, and the grind

A turn no longer blocks because a neighbour session is mid-gate. It resolves in this order
([/decisions/ad-073.md](/decisions/ad-073.md)):

1. **A recorded verdict whose inputs hash matches is reused**, and the lock is never taken. Two sessions editing
   one tree usually land here, because the hash covers the command and the files rather than the session.
2. **Otherwise the turn waits**, up to ten seconds — bounded so the wait plus the gate still fit inside the
   `Stop` hook's 120-second timeout.
3. **If the wait expires the gate defers.** The turn ends, the handoff records `last_gate_result: skipped` naming
   the holder, and a `gate.outcome` carrying `deferred_to` reaches the record, so `tlc harness why` shows it.

Deferring is safe because both sessions share the tree: the neighbour's commands cover this turn's edits too. If
they pass, this turn was legitimate. If they fail, the neighbour is blocked holding the failure and the tree is
still broken, so the next stop in either session blocks on it. What is given up is only *which* turn is told.

A dead or stale holder never causes even the wait: the runtime reclaims past `GATE_LOCK_STALE_MS` (30 minutes) by
age, immediately when the pid is gone, and after a five-second grace window when the body cannot be read or names
no holder — a truncated write, a zero-length file, or JSON without `provider` / `session` / `pid`. Deleting the
file by hand is never necessary.

**An agent cannot switch the grind off from inside a session**, and that is correct: those subcommands are policy
surface ([/decisions/ad-022.md](/decisions/ad-022.md)). Run them from your own terminal.

## `status` disagrees with what a hook does

It no longer can: `status` reads `loadPolicy`, the same resolution a hook performs, and prints where the mode
came from — `[from config]`, `[from file]` or `[from flag]`. If the origin is `flag` or `file` and you expected
`config`, a leftover `tlc harness mode` or `grind on` is winning; clear it with `tlc harness mode solo` or
`tlc harness grind off`.

## A shim hook points at a path that does not exist

`tlc harness init` writes the install path (`~/.tlc/harness/bin/tlc-exec.mjs`), not the checkout behind its
symlink. A shim naming a checkout directory was written by an older runtime — re-run `tlc harness init` to
regenerate it. These files stay untracked on purpose: they carry an absolute path that is only valid on the
machine that generated them.

## Doctor says a provider is "detected but not wired" while hooks fire

The launcher path is compared by the file it resolves to, not by the string. If this warning appears while
hooks demonstrably run, check that the path recorded in the provider's config still exists — a moved or
deleted checkout is a real break, whereas reaching the same file through a symlink is not and no longer
warns.

## Grind not looping

1. `tlc harness status` — grind must be ON.
2. Gates must not be PAUSED.
3. Project `.tlc/harness/config.json` needs `grind.lintCommand` / `grind.testCommand` if you expect those
   gates.
4. On failure, inspect `.tlc/harness/state/last-gate.json` (`findings`, `exitCode`, `outputTail`) before
   trusting chat follow-up text.
5. Concurrent agents: wait for `.tlc/harness/state/grind.lock` or stop the other grind.
6. Stop status must be `completed` (aborted/error skips).

## Subagent model denied

Allowlist + blocked `*-fast`-shaped patterns (provider-specific — see
[/providers/index.md](/providers/index.md)). Check `subagents.allowedModels` in user config and project
`.tlc/harness/config.json`. Dual gate: `subagentStart` + `preToolUse` on a spawn tool. Optional
`subagents.blockParentFast` denies spawns while sticky parent state is Fast
(`.tlc/harness/state/parent-model.json`, see [/decisions/ad-001.md](/decisions/ad-001.md)).

## Cost always null

1. `tlc harness help prices`.
2. `tlc harness prices refresh` (or `refresh cursor` if you only need the primary catalog).
3. `tlc harness prices lookup <model> [provider]` — if null, the id is missing from that provider's
   catalog + LiteLLM.
4. Add an alias in `~/.tlc/harness/model-aliases.json` if the provider's model slug ≠ catalog key.
5. Optional override in `model-prices.json` (local).
6. Events need input/output token counts; duration-only events yield null USD even when the catalog has the
   model.

## Double hooks / slow turns

If both user and project hooks run the same heavy logic without shim no-op, fix shim / `TLC_ACTIVE`. Global
observability hooks should stay in the user-level hook file only (the resolved provider config
directory's `hooks.json` or `settings.json`), not duplicated into the project shim.
