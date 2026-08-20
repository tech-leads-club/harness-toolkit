---
type: Runbook
title: "Measure"
description: "How to read harness observability: status, live signal, raw signal, session reports, audit trail, price catalogs, and the on-disk project state files, all provider-tagged."
tags: [runbook, measure, observability, pricing]
timestamp: "2026-07-29"
---

# Measure

Run from the project root, or set `TLC_PROJECT_DIR`.

## Status

```bash
tlc harness status
```

Shows mode, grind on/off, and whether stop gates are paused.

## Live signal

```bash
tlc harness obs live
```

Allowlisted tail of signal events (session, prompt, fails, denials, gates, compact, subagents, cost alerts).

## Raw signal

```bash
tlc harness obs events [n]
```

Last N JSON lines from `obs.jsonl`.

## Session report

```bash
tlc harness obs report [conversation_id]
```

Markdown rollup: tokens, estimated USD, tools, subagents, gates. Writes under
`.tlc/harness/state/reports/`.

```bash
tlc harness obs rollup <conversation_id>
tlc harness obs prune
```

`rollup` prints the raw JSON rollup for one session; `prune` deletes rollups older than
`retentionDays` (default 14).

## Machine-readable output

Every read command accepts `--json` and then writes exactly one JSON value to stdout and no prose, so a CI
step or an agent can parse it instead of scraping text:

```bash
tlc harness status --json
tlc harness doctor --json          # { ok, failed, warned, checks: [{ id, name, status, detail }] }
tlc harness obs live --json        # { count, events: [...] }
tlc harness obs report --json      # { session, path, rollup }
tlc harness lessons list --json
tlc harness prices lookup <model> --json
```

Without the flag, output is byte-identical to what it has always been. Exit codes do not change either: a
failing `doctor --json` still exits 1 and still emits a parseable value, with `ok: false`, so a caller can
branch on the code or on the payload.

## Global spool

`obs.globalSpool` (off by default) mirrors every obs and audit record into a single file under the runtime
home — `~/.tlc/harness/state/obs-spool.jsonl` — wrapping each one with the repository path and project name:

```json
{"repo":"/work/my-repo","project":"my-repo","stream":"obs","record":{...}}
```

That is what makes cost and gate history readable across every repository at once; per-repo files stay
authoritative and untouched. Writes are best-effort — an unwritable runtime home degrades to project-only
recording rather than failing a hook. `tlc harness obs prune` prunes the spool on the same retention window
as session rollups and reports how many records it dropped.

When the runtime home is itself a checkout reached through a symlink, the spool lands in that checkout's
`state/` directory, which `.gitignore` already covers for exactly this case.

## Retention

`tlc harness obs prune` reads `obs.retentionDays` from project policy (default 14) and applies it to session
rollups and to the spool, reporting how many spool records it dropped. The other tunables — `includePayloads`,
`maxAttrChars`, `sessionCostAlertUsd` — are described in [/concepts.md](/concepts.md).

## Observability planes

Every record carries a `provider` field (`"cursor" | "claude"`) so signal, debug, and audit records from a
multi-provider project stay attributable per-event, not just per-project (see
[/decisions/ad-011.md](/decisions/ad-011.md)).

| Plane | File | Default | Contents |
|-------|------|---------|----------|
| Signal | `.tlc/harness/state/obs.jsonl` | ON | lifecycle, fails, denials, gates, cost alerts, ship claims |
| Debug | `.tlc/harness/state/debug.jsonl` | OFF | happy-path tool/shell/mcp noise |
| Audit | `.tlc/harness/state/audit.jsonl` | ON | one record per hook invocation (`{ ts, event, payload }`), restored per [/decisions/ad-016.md](/decisions/ad-016.md) item 7 so a denied/asked shell command is never silently unaudited |

Set `"observability": { "debugEnabled": true }` in user or project config to also capture debug-level
events. `shell.end` is promoted from debug to signal automatically whenever the permission was not a plain
allow — an audited denial should never require opting into debug mode to see.

18 `HarnessEventKind` values map onto a smaller set of `ObsKind` values (`session.start`, `tool.start`,
`shell.end`, `gate.outcome`, `cost.turn`, …) — see `src/core/observability/observability.types.ts` for the
full mapping table.

## Prices

Fetched per machine, never versioned ([/decisions/ad-096.md](/decisions/ad-096.md)).

```bash
tlc harness prices refresh              # both planes, now
tlc harness prices refresh cursor       # one plane
tlc harness prices refresh --if-stale   # only past the TTL; what install and update run
tlc harness prices lookup <model-id> [provider]
```

| Trigger | Effect |
|---------|--------|
| `tlc harness install` | first fetch; a network failure does not fail the install |
| `tlc harness update` | `--if-stale`, TTL 7 days |
| `tlc harness doctor` | reports the catalogue's age, or that it is absent |

### Files

| File | Role | In git |
|------|------|--------|
| `~/.tlc/harness/model-prices.json` | the catalogue | No |
| `~/.tlc/harness/model-prices.local.json` | hand-written overrides | No |

### Planes

`planes` is keyed by who bills the call. They are not merged: the same model has one rate from its vendor and
another from a provider reselling it.

| Plane | Holds | Source |
|-------|-------|--------|
| `cursor` | what that provider charges | its pricing page |
| `litellm` | vendor list prices | the LiteLLM public JSON |

`_meta.planes[<plane>]` records the source, the model count and the fetch time.

### Resolution order

1. `model-prices.local.json`
2. `planes[<asking provider>]`
3. `planes.litellm`
4. otherwise `cost_usd: null`

Host ids that differ from a catalogue key are mapped in `MODEL_ALIASES` (`src/platform/pricing.ts`). Add your own
by writing the key into the overrides file.

Pools (neutral names in observability records; see [/decisions/ad-011.md](/decisions/ad-011.md) item 2):
`provider_native` | `other` | `auto` | `unknown`. The catalogue uses vendor-named pool keys internally
(`cursor_models`, `anthropic_models`, …) since pricing must name real vendors — those are mapped to the neutral
names before they reach `core/`.

### Refusal

A plane is replaced only if the incoming table keeps at least half of what is on disk. Below that the refresh
refuses, names both counts, and leaves every plane untouched.

## Project state files

| Path | Contents |
|------|----------|
| `.tlc/harness/state/obs.jsonl` | Signal |
| `.tlc/harness/state/debug.jsonl` | Debug (if enabled) |
| `.tlc/harness/state/audit.jsonl` | Verbose per-hook audit trail |
| `.tlc/harness/state/sessions/*.json` | Per-conversation rollups |
| `.tlc/harness/state/handoff.json` | Cross-turn handoff |
| `.tlc/harness/state/ship-ledger.jsonl` | Ship claim / challenge / pass rows |
| `.tlc/harness/state/lessons.json` | Project lessons store |
| `.tlc/harness/state/parent-model.json` | Sticky parent-model snapshot (see [/decisions/ad-001.md](/decisions/ad-001.md)) |
