---
type: Concept
title: "Lessons"
description: "Durable, ranked lessons that keep the agent from repeating gate failures — three tiers, staleness against a named reference, a validity window, effectiveness measured after injection, lifecycle, config, ranking, and the per-provider rendered view."
tags: [concept, lessons, intelligence]
timestamp: "2026-08-04"
---

# Lessons

Durable, compact lessons that keep the agent from repeating **gate failures**. Ranked inject under a char
budget — not conversational memory.

Four things decide whether a lesson reaches a turn: which **tier** it lives in, whether it is still **true**
(its refs resolve, its window is open), how it **ranks**, and whether the budget has room.

## The three tiers

| Tier | Where | Who reads it | Written by |
|------|-------|--------------|------------|
| `core` | inside the runtime | every install, identically | shipped — immutable |
| `global` | `<runtime home>/state/lessons.json` | every product on this machine | `lessons add --global`, `lessons promote` |
| `project` | `<repo>/.tlc/harness/state/lessons.json` | this repository only | gate stagnation, `lessons add` |

`<runtime home>` is `$TLC_HOME`, or `~/.tlc/harness` when it is unset.

**Choosing a tier.** Ask whether the lesson would still be true in a different product:

- "this repository's CI sets `TLC_HOME`" → **project**
- "run the gate itself, never an approximation of its steps" → **global**

Ranking reads all three; `projectBoost` keeps the project tier above the global tier, so local knowledge
outranks knowledge carried in. On a duplicate id the nearer tier wins, so a project that took a global lesson
and rewrote it reads its own version.

**Nothing crosses between products by itself.** There is no automatic promotion, by design: a lesson mined from
a gate failure in one product names that product's test runner and file layout, and no threshold can tell
whether it applies elsewhere. Only the operator can ([/decisions/ad-040.md](/decisions/ad-040.md)).

An injected lesson renders as `[gate/status/tier]`, so a turn reading `[test/active/global]` can tell the advice
was written about a different repository.

`source` is a different fact from `tier`: it records *how* the lesson was learned — `core`, `project` (mined
from a gate failure) or `manual` (authored) — not where it lives.

## Staleness — a lesson names what makes it true

A lesson may carry **refs**, each a repository-relative `path` or `path:symbol`. When a ref stops resolving the
lesson is withheld: a lesson naming a renamed file is worse than absent, because it sends the next turn looking
for something that no longer exists, with the authority of a lesson.

| Status | Meaning | Stale? |
|--------|---------|--------|
| `present` | the path exists, and the symbol appears in it | no |
| `path-missing` | the path is gone, or was absolute | **yes** |
| `symbol-missing` | the file survived, the name did not | **yes** |
| `unreadable` | the file could not be read | no — deferred |

`unreadable` is deliberately not stale. A file this process cannot open is not evidence the lesson stopped being
true. A lesson with **no refs is never stale** — most lessons are about conduct.

Refs are repository-relative; an absolute path never resolves, or a global lesson would report `present` in every
product on the machine that happens to contain the file.

`garden` sets and clears staleness for **project** lessons. A **global** lesson is judged per repository at
selection time instead — its refs may legitimately be missing here and present in the product it came from, so
one stored flag cannot be right for all of them ([/decisions/ad-036.md](/decisions/ad-036.md)).

## Validity window

`validFrom` / `validTo` (ISO) express knowledge with a known end — "pin the formatter until the toolchain moves".
Active when `(validFrom absent or ≤ now) and (validTo absent or > now)`.

An **unparseable bound withholds the lesson**. `--until "next tuesday"` is a typo, and treating a broken
declaration as no declaration would inject exactly what the author meant to limit. `garden` prunes an expired
lesson, because unlike a broken ref the end was declared by the author
([/decisions/ad-037.md](/decisions/ad-037.md)).

## Effectiveness — did the lesson help?

Ranking is built from proxies for usefulness. This is the measurement.

When lessons are injected on a retry for gate G, their ids and G go on the handoff. The **next run of gate G**
grades them: passed → `helped`, failed → `neutral`. The gate name is compared, so lessons injected for `lint` are
not graded by `test`.

| Reading | Meaning |
|---------|---------|
| `helped n/m` | present when that gate recovered, at least once |
| `neutral 0/m` | present at m failures and no recoveries |
| `unproven` | injected **for a gate** and never graded — no evidence, not "fine" |
| `session-only` | injected at session start and never for a gate, so this mechanism cannot measure it |
| `not-injected` | never shown yet |

Only `unproven` is a `doctor` warning. **A session-start injection is never graded** — only the retry path has a
gate whose next run can decide — so a lesson with gate `any` is unprovable by this mechanism rather than
unjustified, and saying otherwise would warn about a healthy store on every run
([/decisions/ad-044.md](/decisions/ad-044.md)).

The rate is `null` over zero graded injections, never `0` — zero would read as "measured and it never helped",
which is a claim the harness has not earned.

**This is not causal.** A gate passing after a lesson was injected does not prove the lesson caused it, and
`neutral` does not mean the lesson was wrong. A causal answer needs the same task run twice, and real work does
not repeat. The counters do not feed ranking, because boosting on a non-causal signal would make the ranking
self-confirming ([/decisions/ad-039.md](/decisions/ad-039.md)).

## Lifecycle

```text
gate stagnation (fingerprint ≥ 2)
  → upsert candidate lesson (project store), recording the session key
garden (sessionEnd / tlc harness lessons garden) — both writable tiers
  → promote candidates (distinct sessions ≥ promoteHitCount)
  → mark / clear staleness (project tier)
  → prune expired
  → decay / quarantine / prune
inject
  → sessionStart: active only, top N / maxChars
  → stop retry: active + matching candidates, gate-scoped; records a pending credit
grade
  → next run of the same gate: helped / neutral
optional
  → sync provider-native durable view (see Provider views below)
```

## Config (`intelligence.lessons`)

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | false | Master switch |
| `maxInjectSession` | 5 | Cap at sessionStart |
| `maxInjectRetry` | 8 | Cap on stop follow-up |
| `maxCharsSession` | 900 | Char budget session |
| `maxCharsRetry` | 1400 | Char budget retry |
| `promoteHitCount` | 2 | Candidate → active, counted in **distinct sessions** |
| `decayLambda` | 0.02 | Exponential decay per hour since the failure last **recurred** (`lastSeenAt`) |
| `projectBoost` | 1.5 | Score multiplier for the **project** tier |
| `syncRulesFile` | `auto` | Write the provider-native durable view: `auto` where the provider does not deliver hook context, `always`, or `never` |
| `gardenOnSessionEnd` | true | Garden on sessionEnd |

## Ranking

`score = relevance(gate, tokens) × confidence × exp(-λ · hours since lastSeenAt) × projectBoost?`

**Hours are counted from recurrence, never from exposure.** `lastSeenAt` moves only when the failure
signature happens again; `lastAccessedAt` moves when a lesson is *shown* and is telemetry only. Decay and
pruning both read `lastSeenAt` — reading the exposure field made relevance self-fulfilling, so a lesson that
merely matched a gate name kept resetting its own clock and never faded
([/decisions/ad-023.md](/decisions/ad-023.md)).

**Promotion counts distinct sessions, not `hitCount`.** `hitCount` counts recurrences of the same gate
fingerprint, and one stuck session produces those by definition — the stagnation rail exists because sessions
repeat themselves. A record written before session keys existed falls back to `hitCount` so it can still promote
([/decisions/ad-038.md](/decisions/ad-038.md)).

A lesson also retires when its cause is gone: the garden prunes a `verification` lesson whose stored signal is
an unresolved gate command, because AD-021 made that class classify as `config` and it can no longer recur.

Pack **whole lesson blocks** under the char budget. Never mid-string `slice` a lesson. When the budget is
full, omit lower-ranked lessons entirely and append `_(N more active lessons omitted under char budget)_`.

Session inject stops at the first lesson that does not fit (no filler with lower-ranked leftovers).
Quarantine never injects. Stale and out-of-window lessons are excluded **before** ranking, not scored low.

**The budget usually binds, and says so.** `maxCharsSession` defaults to 900 and a rendered block is four lines,
so about two fit while `maxInjectSession` says five. The injected block names what it dropped:

```text
  (3 more eligible lessons omitted under the char budget — raise maxCharsSession to see them)
```

## Pinning a standing rule

Ranking weighs recurrence, decay and gate match — all estimates about a lesson the harness *inferred*. An
instruction the operator wrote deliberately has no recurrence to accumulate, so making it compete on score is a
category error: it loses to a shipped seed and never arrives.

```bash
tlc harness lessons add "Never declare done without an end-to-end run pasted into the reply." --global --pin
```

A pinned lesson is placed **before every scored lesson**, in store order. Everything else still binds — staleness,
the validity window, mode filtering and the char budget — so pinning changes order, not eligibility, and a pinned
rule naming a renamed file is withheld like any other. Nothing caps how many can be pinned; the budget bounds
delivery and `lessons list` marks each one `PINNED` ([/decisions/ad-043.md](/decisions/ad-043.md)).

Going first means taking the room first. `maxCharsSession` defaults to 900, a rendered lesson runs 300–500
characters, and the six shipped seeds compete for the same budget — so one long pinned rule can be the only thing
that arrives:

```bash
tlc harness doctor    # lesson budget — N eligible lessons never reach the model at session start
```

That row names how many fit, how much of the budget they used, and which pinned lessons went first. Raise
`maxCharsSession`, shorten the rule, or unpin one. Without it the shortfall was only visible inside the injected
block, which the model reads and the operator does not ([/decisions/ad-100.md](/decisions/ad-100.md)).

## Provider views

`.tlc/harness/lessons.md` is the source of truth, and the store, the ranking, the budget and the rendered text are
shared by every provider. What differs is **transport** — how the text reaches the model — and that is a declared
capability rather than a preference ([/decisions/ad-050.md](/decisions/ad-050.md)):

| Provider | `sessionStartContextReliable` | Rendered view |
| --- | --- | --- |
| Cursor | `false` — `additional_context` returned from `sessionStart` is accepted, logged as merged, and dropped; acknowledged by Cursor as a race between the hook and the composer handle (forum 158452, 2026-04-20; reported again against 3.14.7 on 2026-08-02) | `.cursor/rules/harness-lessons.mdc` (`alwaysApply: true`) — the durable route, and on this host the only reliable one |
| Claude Code | `true` — `SessionStart` delivers `hookSpecificOutput.additionalContext` | a single `@.tlc/harness/lessons.md` import line appended to `CLAUDE.md`, under `always` |

Under the default `auto`, the view is written where the provider does not deliver hook context and withheld where it
does. `always` writes it everywhere; `never` writes it nowhere, which is how an operator declines a file in their
repo. A config carrying the field's old boolean still works — `true` reads as `always`, `false` as `never` — and
`tlc harness lessons list` names the coercion.

The view carries all three tiers and only what would actually be injected, so a withheld lesson never appears there
and a core or global lesson is not missing from it. It is written at session start as well as session end, because a
transport that is one session behind carries the previous session's guidance.

`tlc harness obs report` says which of the two is paid: the emission where the host delivers it, the rules file where
it does not.

## Design notes

| Insight | Applied here |
|---------|--------------|
| Lessons are atoms | Whole-block pack in `packLessonsUnderBudget` / the provider-view renderers |
| Rank before cut | Inject by `rankScore`; sync by priority → hitCount → confidence |
| Promote on repeat across sessions | distinct `sessionKeys` ≥ `promoteHitCount` |
| A claim outlives its subject | Refs + staleness, withheld not deleted |
| Some knowledge expires | Validity window, pruned on expiry |
| Usefulness is measured, not assumed | helped / neutral / unproven after the next gate run |
| Knowledge travels, context does not | Three tiers, operator-invoked promotion, tier in the rendered line |
| Grounded only | Gate stagnation / failures / an author — not chat memory |
| Noise control | Cap N + maxChars; omit note instead of half-sentences; garden decay/quarantine |

## CLI

```bash
tlc harness lessons add "<instruction>" [--gate <name>] [--avoid "..."] [--prefer "..."] \
                        [--tokens a,b] [--ref path[:symbol]] [--until <iso>] [--global] [--pin]
tlc harness lessons promote <id>          # copy a project lesson into the global tier
tlc harness lessons list [--all] [--json]
tlc harness lessons show <id>
tlc harness lessons garden
tlc harness lessons sync-rules
tlc harness lessons path
```

`--ref` may repeat. `list` marks a withheld lesson `WITHHELD` and reports `effect=`, `validity=`, `stale=` and
`refs=` per lesson.

**Two different counts at the end, on purpose.** The tier line counts what would be *injected*, after the nearer
tier wins a duplicate id. The store lines count what is *on disk*. A promoted lesson lives in both stores and
resolves to the project copy, so without the second pair an operator reads `core=6 project=5` and concludes
`promote` did nothing:

```text
11 lessons — core=6 project=5
stale=0 out-of-window=0 unproven=0 not-injected=11
project store: <repo>/.tlc/harness/state/lessons.json  (5 lessons)
global store:  ~/.tlc/harness/state/lessons.json  (5 lessons, 5 also in this project)
```

`doctor` reports stale, out-of-window and unproven lessons as separate warnings, and stays silent when the
capability is off or the writable tiers are empty. When everything is healthy it prints one row:

```text
OK    lesson health — 10 lessons across the writable tiers, none stale, none out of window
```

## When the synced file looks empty

The synced markdown is a rendering of the store, so an empty one has a reason and now names it
([/decisions/ad-049.md](/decisions/ad-049.md)):

| What the file says | What is happening |
| --- | --- |
| `switched off … intelligence.lessons.enabled is false` | the capability is off, so no gate failure is ever recorded — and off is the default |
| `No lesson recorded yet` | on, but no failure has repeated inside a session yet |
| `N candidate lessons recorded, none promoted` | recorded, waiting for the same failure in `promoteHitCount` distinct sessions |
| `N active lesson is withheld` | promoted, but a ref stopped resolving or a window closed |

Three hurdles stand between a gate failing and that file showing anything: the capability has to be on, the *same*
failure has to repeat inside a session, and the candidate has to be promoted across distinct sessions. One sentence
covered all of them, which reads as broken.

**`.specs/LESSONS.md` is not this file.** It belongs to the `/sdd` skill, which keeps its own lessons layer. The
harness writes one file and nothing else.

## Reading the store from a test

The suite runs with `TLC_HOME` pointed at an empty temporary directory, so no test can read the lessons an
operator happened to promote on that machine. A test that needs the real runtime home sets it explicitly
([/decisions/ad-042.md](/decisions/ad-042.md)).

## Trade-offs

| Benefit | Cost |
|---------|------|
| Stops repeating the same gate mistake across sessions | Uses context tokens |
| Gate-scoped + decay stays relevant | Needs enable + occasional garden |
| A lesson retires when its subject is renamed | Refs are author-supplied; substring matching accepts a false `present` |
| Knowledge follows the operator across products | A global lesson can be irrelevant in some product; refs and the boost bound it |
| The store can be defended with numbers | The grading is correlational, not causal |
| Provider-view sync survives hook races | Can dirty the provider's own rules/memory file if enabled |
