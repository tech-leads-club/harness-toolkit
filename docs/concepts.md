---
type: Concept
title: "Concepts"
description: "The operator-facing concepts behind the harness: operator posture, grind, pause/resume, shipGate, subagent allowlist, comment policy, duplication, catastrophic shell, shell stall, the intelligence rails, observability planes, and cost estimates."
tags: [concepts, policy, posture, grind, shipgate, observability]
timestamp: "2026-07-29"
---

# Concepts

## where a setting lives

Three layers, and the nearer one wins: the shipped defaults, then the runtime home's own config for this machine,
then the project's config. The machine tier is operator-owned — `install` and `update` never write it — so a
preference that is true everywhere belongs there and is written once.

The catch is that naming a value in the project file stops it tracking the machine tier, for ever. `init` writes
the whole default policy when a project has no config yet, and the wizard writes every knob it collected, so a
project config usually names dozens of values nobody chose. Raise a machine-wide number afterwards and none of
those repositories see it.

`tlc harness doctor` names the keys this project restates rather than decides, with the file they stopped
tracking. Deleting them is safe: the value does not change, it goes back to being inherited.

Both tiers are refused to an agent, on the write-tool path and through a shell redirect
([/decisions/ad-022.md](/decisions/ad-022.md)).

## which runtime answers a hook

`TLC_HOME` names it, and it wins over the location of the launcher that was invoked. So one session can run a
checkout while every other session on the machine keeps the installed copy:

```bash
export TLC_HOME=/path/to/clone
```

A checkout serves its hooks from `src/` when Bun is present, so a file saved half-edited is live on the next hook
— in that session only. That isolation is the reason to do it this way rather than installing the clone as the
machine's runtime: `tlc harness install --link` makes a working tree the runtime for *every* session, which is the
contributor route and why `doctor` names it distinctly (`runtime ownership — link to a working clone`).

Most work needs no live session at all: `tlc harness test` runs the gate hermetically, and the entrypoints can be
driven with real hook payloads from a scratch directory.

A machine with both — an installed copy and a checkout — is fine, but only one `tlc` should be on `PATH`, or which
runtime you get depends on which one the shell resolved. `doctor` reports the resolved runtime and its ownership on
every run, which is where a split shows up: the skill links and the wired hooks are checked against the runtime
that answered, so pointing at the other one reads as a fault.

## operator posture

`mode`, or `tlc harness mode <paired|solo|focus>`. It sets how much the agent surfaces and what earns an
interruption — nothing else. Verification is identical at all three: the same evidence bar, the same gates, the
same done-criteria ([/decisions/ad-025.md](/decisions/ad-025.md)).

- **paired** — explains as it goes, and asks before any sizable move. A shell command that reaches the network, or
  that can overwrite or remove a path that already exists, is asked about before it runs — so this posture is
  enforced rather than merely stated
- **solo** (default) — works on its own. Three things reach you: an irreversible or destructive action, a real
  dead-end after exhausting sources, and ambiguity that changes the outcome
- **focus** — only a destructive action or a real dead-end reaches you. Ambiguity is the agent's to settle,
  taking the most reasonable reading and stating the assumption in one line

**Every posture also carries a deadline, not just a threshold.** An unclear goal belongs in the agent's first
actions; once the work is under way it takes the most reasonable reading and states the assumption instead of
asking, because a late question is measurably worse than a decision. `focus` admits exactly one early question —
a goal it cannot read before starting — so it means *ask early or not at all*, never simply never ask
([/decisions/ad-026.md](/decisions/ad-026.md)).

Three tiers ask, and each names a different risk: a command that **leaves the machine**, one that **can overwrite
or remove** an existing path, and one that **changes who can reach** a path. That last one — `chmod`, `chown` — is
asked about even though it loses no data, because it is the only change that appears in no diff. An append is the
one shape that does not ask: content survives it, and asking about it would train you to clear the prompt without
reading, which is how the action that mattered gets waved through. `cp`, `mv` and `tee` stay in the asking tier,
because each can overwrite a destination and the harness cannot know whether that destination exists.

Precedence: the `harness-mode` state file, then a posture flag file, then `mode` in the config, then the default.
Any other value is refused rather than absorbed — `tlc harness status` and `tlc harness doctor` name the rejected
word and the posture running in its place.

Posture never switches a gate or a capability on. `focus` used to force grind on, which meant a surfacing
preference silently overrode a capability with its own switch and its own trade-off.

## grind

`grind.enabled`. After each completed agent turn, run configured lint/test against **relevant** changed files:

- **lint** — only when files under `codePaths` changed
- **test** — when test files or `codePaths` files changed. Policy-only / non-code changes do **not** trigger the
  test gate. Posture does not narrow this: the change that most needs testing is the one with no test file in
  the diff ([/decisions/ad-025.md](/decisions/ad-025.md))

`grind.appendFiles` decides whether the changed files are appended to the lint/test argv. `auto` (default) appends
them, and refuses in three cases where appending cannot narrow the run:

| Shape | Why it does not narrow |
|-------|------------------------|
| a recipe runner — `just`, `make`, `task`, `mise`, `rake` | takes a target name; the first path reads as a second target |
| a package-manager script — `npm test`, `yarn test`, `bun run test` | the argument goes to somebody else's script, and whether it reaches the runner is not something the harness can know |
| a command that already globs — `eslint "src/**/*.ts"` | it walks the glob regardless, so appending widens rather than narrows |

`npx`, `bunx` and `dlx` are transparent: the tool named next is what decides, so `npx jest <file>` still narrows.
`always` and `never` override all of it.

**When `auto` cannot narrow, the gate runs in full on every attempt — up to `maxLoops`.** A four-minute suite with
three attempts is twelve minutes of tests, and that is the shape behind most reports of the harness being slow.
`tlc harness doctor` names any command in that state and says why; `tlc harness obs report` shows the runs and the
total ([/decisions/ad-033.md](/decisions/ad-033.md)).

Lint/test runs are serialized with a lock in the project state directory. A neighbour session holding it does not
block the turn: a recorded verdict whose inputs hash matches is reused and the lock is never taken, otherwise the
turn waits a bounded share of the stop hook's timeout, and if that expires the gate **defers** — the turn ends,
the handoff records `skipped`, and the holder is named ([/decisions/ad-073.md](/decisions/ad-073.md)).

A lock is reclaimed when it is older than 30 minutes, when it cannot be read, or when its owning process is gone
— the last one only on the host that wrote it, since a pid means nothing on another machine
([/decisions/ad-024.md](/decisions/ad-024.md)).

Each lint/test invocation writes `.tlc/harness/state/last-gate.json` (`harness.gate.v1`) with exit code,
command, files, `outputTail`, and `findings`. Follow-up gaps and stagnation fingerprints use that artifact.
Optional: the child may write findings to the path in `HARNESS_GATE_REPORT` (JSON
`{ "findings": [{ "summary": "..." }] }`).

On failure, send a follow-up so the agent fixes (loop, capped). Identical failure fingerprints trigger a
stagnation follow-up. Trade-off: catches breakage early; burns turns if gates are flaky.

A gate whose command never ran — exit 127, or a runner that could not resolve the target — is reported as
`config`, not `verification`. The distinction matters: the verification follow-up tells the agent to fix the
findings without deleting tests, which on a malformed command sends it to edit healthy code.

## pause / resume

`tlc harness pause` disables stop checks (grind + ship challenge). Use when exploring or mid-refactor.
`tlc harness resume` turns them back on.

Run both from your own terminal. Inside an agent session they are denied by the floor rule
`policy-surface-write`: policy is the operator's to change, and a stop check the agent can switch off is not a
stop check ([/decisions/ad-022.md](/decisions/ad-022.md)).

## gate commands

`tlc harness gate test-command <cmd> [args...]` and `tlc harness gate lint-command <cmd> [args...]` set
`grind.testCommand` and `grind.lintCommand` in the project policy. This is the only supported way to change
those fields — editing `config.json` by hand is fine for you as the operator, but no agent route reaches it.

```bash
tlc harness gate test-command node --test 'src/**/__test__/*.test.ts'
tlc harness gate lint-command npx biome check .
```

Each refuses without writing when the argv is empty, when the first element does not resolve on `PATH` (a gate
command that cannot run is a config fault, AD-021), or when stdin is not a terminal.

## policy integrity

Every source the policy loader reads — the project config, the runtime config, `harness-mode` and the flag
files — is hashed when a session starts. If one changes during that session without a `tlc harness` command
behind it, the next tool call is refused and the changed path is named. The check has no config switch, for
the same reason the floor does not: a detector the detected change can disable is not a detector.

Editing the config between sessions never triggers it. Baselines are per session, so concurrent sessions do
not interfere, and every `tlc harness` mutation re-records them.

## shipGate

`shipGate.enabled`. Ship challenges fire **only** after an explicit protocol line in the agent response:

```text
HARNESS_SHIP_CLAIM: <one-line summary>
```

Prose without that marker does not count as a ship claim.

When a claim is recent (`claimWindowMinutes`, default 10), changed files touch `runtimePathPrefixes` after
`runtimePathExcludes`, and there is no recent PASS under `evidenceDir/*/90-verdict.txt`, stop follows up
with BLOCKED.

Outcomes append to `.tlc/harness/state/ship-ledger.jsonl` (`claim` / `challenge` / `pass`), each row tagged
with the resolved `provider`.

Default excludes: `.tlc/`, `**/node_modules/`, `**/.git/`. `src/core` stays provider-neutral by design
([/decisions/ad-011.md](/decisions/ad-011.md)), so a provider's own directory (`.cursor/`, `.claude/`) is
not a core default — add it to your project's `shipGate.runtimePathExcludes` if `runtimePathPrefixes` is
customised broadly enough to reach one.

## emptyDiffAntiShip

`shipGate.emptyDiffAntiShip`. When enabled, a recent `HARNESS_SHIP_CLAIM` with zero changed files is blocked. Omit the claim line when an
empty diff is intentional.

## subagent allowlist

`subagents.enforceAllowlist`. Task/subagent models must be on `subagents.allowedModels`, which is **yours** — no
provider ships a catalogue, because one the harness invents goes stale and then refuses a spawn by a list that
appears nowhere in the project ([/decisions/ad-053.md](/decisions/ad-053.md)). An empty list enforces nothing and
`doctor` reports the combination as a fault. `*-fast`-shaped models are blocked separately, by patterns that are
added to yours rather than replacing them. `inherit` is a value the list may contain. Trade-off: cost/quality
control; you update the list when a provider adds models you want.

## Block parent Fast

`subagents.blockParentFast` (default off) denies a Task/subagent spawn while the sticky parent model is a
"fast" variant, even when the spawn's own `model` string looks allowlisted. See
[/decisions/ad-001.md](/decisions/ad-001.md).

## comment policy

`comments.enabled`, with `comments.mode` of `declared` or `strict`. Blocks the stop when the turn added
comment lines, so narration never lands. Diff-scoped against the sha the turn started from, not `HEAD`:
a turn that commits its own work moves `HEAD` past the very lines being judged, which is how the gate
missed every comment in a committing turn ([/decisions/ad-058.md](/decisions/ad-058.md)). Comments already
committed before the turn are never flagged. `declared` keeps a comment that states `why:`, `hazard:` or `invariant:`; `resolvable` is `declared` plus the
question a marker cannot answer — can a reader at HEAD, with no transcript of the session, resolve every
reference and check every claim? It refuses change narration, citations only the session could see, pull-request
vantage, comments arguing their own correctness, and control-flow narration, and asks for a restatement rather
than a deletion ([/decisions/ad-070.md](/decisions/ad-070.md)); `strict` accepts none and
asks the operator to write it. Tool directives (`biome-ignore`, `@ts-`, `noqa`, `shellcheck`, shebang) are
exempt in both modes, and so is a generator's own banner (`@generated`, `"generated ... do not edit"`) —
no agent chose those words and deleting one only reappears on the next regeneration
([/decisions/ad-112.md](/decisions/ad-112.md)).

When `onViolation: "followup"` (the default), an Edit/Write also gets an early, non-blocking `HEADS UP` the
moment it adds an undeclared comment — scoped to that one file, same diff base as the stop-time check,
which still blocks unchanged ([/decisions/ad-111.md](/decisions/ad-111.md)).

## supply chain

`supplyChain.enabled`, off by default. Blocks the stop when this turn added a dependency and left one of two
things undone: the paired lockfile did not move, or the specifier names no version — `latest`, `*`, `x`, or blank.
Diff-scoped against the sha the turn started from, so a manifest already unlocked before the turn is not this
turn's to answer for.

A manifest is recognised by filename from one table that pairs each with its lockfile, and accepts any lockfile
the ecosystem uses — a project on pnpm has locked as firmly as one on npm. A filename the table does not carry
produces no findings.

For a JSON manifest the declared dependency sections decide what counts, so the manifest is read as it stands.
Without that step a rename reads as a dependency: calibrated against this repository's own history, the textual
shape alone reported `"name": "harness-toolkit"` from a rename commit, and would report every `scripts` entry the
same way.

It does not check advisories, licences or typosquats. Each needs the network on every stop, and `npm audit` is
already a gate command an operator can configure.

## duplication

`duplication.enabled`, off by default, with `duplication.minRun` (default 6). Blocks the stop when this turn
added a run of that many lines or more that already exists somewhere else in the project, naming both sites.
Diff-scoped against the sha the turn started from, like the comment gate: a run that was already duplicated
before the turn is not this turn's to answer for.

Three things are excluded, each because measuring said so. **Comments**, so two identical licence headers are
not a duplicated implementation. **Dependency declarations** — `import`, `require`, `use`, `#include` and their
siblings — because they are identical in every file that needs the same thing. **Pure data**: a run has to carry
operations, a call, an assignment, a branch or a return, in the majority of its lines, so a repeated object
literal, type body or export list does not count. Repeated shape is what those are for.

The comparison ignores indentation and a trailing comma, and nothing else. Renaming an identifier makes it a
different run on purpose — a rule that matched through renames would report every similarly shaped function.

It reads every tracked file on stop, bounded at 2000 files and 8 MB, and says when a bound was reached: a scan
that silently covered half a project reads as a clean answer.

## docs staleness gate

`docs.command`, optional and off by default. It is the repository's own staleness tool — `drift check`,
`oasdiff`, `ast-grep scan`, or a script the repo already has — run on stop through the same lock, artifact and
failure path as the lint and test gates.

`docs.severity` is `warn` or `deny`. `warn` injects the tool's output and lets the turn end; `deny` blocks and
goes through the standard gate failure path, which brings stagnation fingerprinting and progressive follow-up
with it.

The harness does not infer staleness from paths. A source-glob to docs-glob map was measured reporting on
82–100% of commits, which detects nothing, so a repository without a real tool gets no gate rather than a
noisy one. The tool also owns its own escape hatch, so there is no harness-level skip token.

## catastrophic shell

`shell.catastrophicAsk`. The shell-before hook asks before commands that can destroy data outside the workspace. Happy-path allows
are not signal events.

## shell stall

`shell.stallDetection`. When enabled, repeating the same shell command N times (`stallRepeatThreshold`) is denied with a
change-approach follow-up. Trade-off: stops loops; can block intentional retries.

## intelligence (rails)

| Key | Effect |
|------|--------|
| `intelligence.gapFeedback` | Gate fails include structured PREVIOUS_GAPS + NEXT suggestion |
| `intelligence.failureClassification` | Handoff stores category (verification, ship-evidence, stagnation, …) |
| `intelligence.progressiveHandoff` | sessionStart reads the gaps the previous session ended with back out of the handoff, capped at five and counting the rest. Phrased as history: only the next run of the gate says whether they still hold |
| `intelligence.progressiveContext` | Each stop retry escalates context (merge prior gaps, more gate output, stronger "don't repeat") |
| `intelligence.autopilot` | Runtime emits ordered AUTOPILOT steps + NEXT_ACTION (not LLM-invented plan) |
| `intelligence.lessons.enabled` | Durable gate lessons with decay/promote; inject at sessionStart + stop retry (see [/lessons.md](/lessons.md)) |
| `intelligence.budgetContinue` | Under loop/context pressure **and** unfinished handoff work, follow-up says keep working — do not summarize |
| `intelligence.idleTurnGate` | Blocks a turn that ends with open handoff work, zero recorded tool calls and zero file changes. It counts events the harness recorded rather than reading the reply, so no wording satisfies it |

## operator rules

`rules.enabled` (off by default). The operator writes a rule per markdown file, and the harness enforces it. Two
tiers apply together, the way the lesson tiers do — one in the runtime home for every repository on this machine,
one in the project for the team — deduplicated by file name with the project winning. A project rule carrying
`enabled: false` switches a global one off there, and its body is where the reason goes.

Switching it on takes two things, and one without the other enforces nothing:

```
rules.enabled: true             in .tlc/harness/config.json
<project>/.tlc/harness/rules/*.md   the team's rules, versioned with the repository
<runtime home>/rules/*.md           this machine's rules, every repository — the path doctor prints
```

`tlc harness doctor` lists every active rule, its tier and its verdict; with the switch on and no file it says so
rather than reporting nothing, because an inert mechanism and a working one otherwise look identical.

```markdown
---
on: pr-open                            # pr-open | commit | push | stop | tool(<name>) | command(<pattern>)
require:
  - subagent(the-jury) since HEAD      # subagent | command | gate | file, since HEAD or since session
otherwise: deny                        # deny | ask | follow-up | warn
---

Convene the jury on this branch. Checklist: docs/review-checklist.md
```

The frontmatter is what the harness enforces; the body is the operator's own text, injected verbatim when the rule
fires. A proof is satisfied only by something the harness observed: a subagent of that type finishing, a command
that ran and did not fail, a gate that passed, a file that changed. The agent cannot create one — the observation
store is under the project state directory, which the floor refuses to an agent, and the mutating `tlc harness`
subcommands are refused from inside a session.

`since HEAD` compares the sha the observation was made against with the current one, so a review followed by
another commit is stale. A project with no git checkout cannot satisfy `since HEAD` at all.

A denial says which of two things happened: nothing of that kind and value was ever observed here (a flat
`missing …`), or it was, just not inside the window (`missing … (ran, but at a different commit)` /
`(ran, but in a different session)` / `(ran, but this project is not a git checkout, so since HEAD can never
be satisfied)`). The first of those three is common with more than one branch checked out of the same working
directory in turn — the proof is real, it is just stamped against whichever commit was checked out when it
ran, not the one the current command has in mind.

Each proof kind matches differently — picking the wrong one for what you actually want to check is the
most common way a new rule reads as protection and is not:

| proof | what it names | how it matches |
|---|---|---|
| `subagent(<type>)` | the *declared type* of a spawn that finished, not the name the spawning agent gave it | exact string |
| `command(<pattern>)` | a shell command that ran and did not fail | the pattern's words, in order, as a contiguous run inside the command — `command(gh pr create)` matches `gh pr create --fill`, not `gh api pulls`|
| `gate(<name>)` | one of this harness's own gates *passing* — never just running | exact string; the only names a gate ever reports are `lint`, `test`, `docs` |
| `file(<pattern>)` | a file edited by a write tool | exact path, **or** `*<suffix>` (a leading `*`, matched against the path's end), **or** `<dir>/` (a trailing `/`, matched as a prefix) — three shapes, not a glob engine |

One example per kind (shown separately — `require:` is a conjunction; listing more than one demands
all of them):

```
require:
  - subagent(<type>) since HEAD      # a spawn declaring exactly <type> finished
  - command(<pattern>) since session # a shell command containing <pattern>, in order, ran this session
  - gate(<name>) since HEAD          # this harness's own <name> gate passed at the current HEAD
  - file(<pattern>) since HEAD       # a file matching <pattern> was edited since HEAD
```

**A `subagent(<type>)` proof needs the host to let the agent declare an arbitrary type when it spawns
one.** Some hosts only offer a closed set of built-in spawn types and cannot declare a custom name at
all — a rule naming one there never has a producer and denies forever, not because the work never ran
but because the host has no way to say which custom kind ran (Cursor's `Task` tool is one example: its
type field is a fixed enum, not a free string, so a custom skill name can never appear there no matter
what the skill itself is called). A rule meant to hold on every host the operator actually uses should
prove itself with something every host can produce identically: `command(<the work's own command>)` —
the exact command the work already runs to do its job — is the portable choice, because running a
command is not a closed set the way declaring a spawn's type can be. `subagent(<type>)` is the right
proof only when every host the rule has to survive on can actually declare that type.

The four verdicts land differently at the two moments a rule can fire:

| verdict | on an action | at the stop |
|---|---|---|
| `deny` | refuses the action | refuses the stop |
| `ask` | asks under `paired`, refuses otherwise | refuses the stop — no host offers an ask there |
| `follow-up` | allows | refuses the stop, framed as the next action |
| `warn` | allows | advisory text, and the stop is allowed |

`on: stop` rules are read only at the stop, and they are read after the lint, test and docs gates have run — so a
rule asking for `gate(test) since HEAD` can be satisfied by the gate this turn.

Posture reaches `ask` and nothing else: it interrupts under `paired` and hardens to `deny` under `solo` and
`focus`. `deny`, `follow-up` and `warn` are verification and are identical at all three
([/decisions/ad-025.md](/decisions/ad-025.md)).

A pattern trigger is policy rather than containment. A script written to disk and executed later, a command name
built at runtime, `gh api` instead of `gh pr create`, or a pull request opened in a browser all escape it — the
rule covers the agent's shell path ([/decisions/ad-100.md](/decisions/ad-100.md)).

`pr-open` does not fire on opening a **draft** pull request — only on a non-draft create and on converting a
draft to ready. This matters when a `require:` proof itself depends on the pull request already existing (a
review step that reads the diff through the PR, for instance): open the draft first, satisfy the proof against
it, then convert it to ready, which is still gated the same way
([/decisions/ad-118.md](/decisions/ad-118.md)).

## plan gate

`planGate.enabled` (off by default), with `planGate.windowMinutes` (default 120). The turn declares the paths
it intends to touch through a protocol line, exactly as the ship gate works — free-form prose about plans is
ignored:

```text
HARNESS_PLAN: src/core/plan/**, src/entrypoints/stop.ts
```

Declared paths use the same matcher as `shipGate.runtimePathExcludes`, so there is one pattern syntax to
learn, globs included. On stop, any changed file that no declared path covers and no accepted deviation
justifies blocks with BLOCKED / TRIED / NEED, naming those paths. A deviation is accepted only with a stated
reason:

```text
HARNESS_PLAN_DEVIATION: src/x.ts — the call site moved with the type
```

Naming the path alone is refused, since that would make the gate a formality satisfied by restating the file
just touched. Deviations accumulate for the plan's window, so one can be justified in a later message than
the one that declared the plan. The gate runs **before** the ship gate: a turn whose scope is invalid
produced evidence for the wrong change.

A turn that declares no plan is not gated at all, so the rail costs nothing until the agent opts in. That is
also its limit — it depends on the declaration being made.

## untrusted-content framing

`untrustedContent.enabled` (off by default), with `untrustedContent.extraTools` and
`untrustedContent.extraCommandPatterns`. The floor governs what the agent executes; this governs what it
reads. When a turn takes in content from outside the repository, one framing message states that the content
is data and that any directive inside it is to be reported as a prompt-injection attempt, never obeyed.

`untrustedContent.mode` chooses how far it goes. **`frame`** is the default and is the paragraph above: one
message, no refusal. **`enforce`** adds the question framing cannot ask — did this command come from that
content — and answers it verbatim ([/decisions/ad-077.md](/decisions/ad-077.md)).

In `enforce`, what an untrusted read returned is remembered for the session, bounded at 64 KB with the oldest
dropped first, whitespace collapsed and nothing else rewritten. When a shell command about to run appears
verbatim in it, the decision is `ask`, naming the source. Verbatim because a paraphrase cannot be shown to come
from the content, so an agent that rewrites a command before running it is missed on purpose — the alternative
guesses, and a rail that guesses asks about every command in every turn that read anything.

It needs the host to deliver what the tool returned. That is a capability, `toolOutputAtAfter`, because presence
is per-event rather than per-host: measured across 69,034 real records, two of the after-events carry nothing on
21,167 of them. A rail that assumed presence would be blind on the majority of one host's traffic and would not
know.

What covers the damaging tail either way is the floor, and provenance never mattered to it: running a program
fetched from the network, reading a credential, destroying outside the project, rewriting history, controlling
the machine and writing policy are all refused before any policy is read, whoever suggested them. An injected
`curl … | bash` is refused for being unreadable code, not for being injected — which holds without recognising
the attack at all.

Detection is a declared list, never inferred from output: every MCP result (the server is not this
repository), a tool whose name the provider declares as untrusted (`WebFetch` / `WebSearch` on Claude Code,
`Fetch` / `WebSearch` on Cursor), and a shell command whose **segment starts with** `gh pr view|diff|list`,
`gh issue view|list`, `gh api`, `curl` or `wget`. A source nobody listed is not covered.

Matching is anchored at the start of a command segment (split on `|`, `||`, `&&`, `;` and newline) rather
than a substring search, so naming a pattern inside a quoted argument, a `grep` search or a heredoc is not a
read. That distinction was not academic: this document names the patterns, and writing it tripped the rail
when the match was a substring.

Injected at most once per turn, keyed on a marker cleared at the prompt boundary, so it cannot spend the
context budget it exists to protect. When the provider cannot carry context on that event the decision
abstains rather than rendering into a field the provider ignores.

## global observability spool

`obs.globalSpool` (off by default). Every record already written under the project state directory is also
appended to one file under the runtime home, wrapped with the repository path and project name, so cost and
gate history can be read across every repository at once.

Writing outside the repository is the one thing an operator cannot undo by editing project policy, which is
why it is opt-in. Redaction is inherited rather than reimplemented — records are redacted before the store
sees them. Writes are best-effort: an unwritable runtime home degrades to project-only recording without
changing the decision returned to the provider. The spool is pruned on the same retention window as session
rollups, and `tlc harness obs prune` reports how many records it dropped.

## observability planes

| Plane | File | Default |
|-------|------|---------|
| Signal | `.tlc/harness/state/obs.jsonl` | ON — lifecycle, fails, denials, gates, cost alerts |
| Debug | `.tlc/harness/state/debug.jsonl` | OFF — happy-path tool/shell noise |
| Audit | `.tlc/harness/state/audit.jsonl` | ON — verbose per-event record, restored per [/decisions/ad-016.md](/decisions/ad-016.md) item 7 |

Which plane an event lands on is fixed by its kind. What a project can tune is the `obs` block:

| Key | Effect |
|-----|--------|
| `obs.globalSpool` | Mirror every record into the cross-repository spool (see above) |
| `obs.includePayloads` | Keep tool payloads in `attrs` instead of stripping them |
| `obs.maxAttrChars` | Truncation budget for `attrs` on every recorded event |
| `obs.sessionCostAlertUsd` | Threshold for the session cost alert; `null` disables it |
| `obs.retentionDays` | Window used by `tlc harness obs prune`, for rollups and the spool |

`debugEnabled` is deliberately **not** a project field: every event that resolves to debug level is emitted
with the audit configuration, which forces debug on so the audit trail persists
([/decisions/ad-016.md](/decisions/ad-016.md) item 7). There would be nothing for a project to switch.

An `"observability": { … }` block is not read at all — it never was. It was removed rather than honoured,
per [/decisions/ad-003.md](/decisions/ad-003.md). Full detail: [/measure.md](/measure.md).

### interruption rate

Every shell decision is recorded with the permission it produced, the active posture and the rule responsible —
`shell-posture-paired`, `shell-catastrophic` or `shell-stall`. An allow resolves to debug level and is dropped by
default, so only the interruptions reach disk. The session report shows them attributed by rule, because "seven
interruptions" names no switch while "six from the posture, one from the catastrophic rule" does. That is how you
calibrate the posture from your own sessions instead of trusting a threshold someone else chose
([/decisions/ad-026.md](/decisions/ad-026.md)).

What this is **not**: the harness records the decisions it made. It never learns your answer, and it cannot know
whether a question it did not ask would have helped. So it reports a rate and its attribution — never a precision,
a recall, or an accuracy of asking. Floor denials are outside it too: `rm -rf /` never reaches a policy layer.

## cost estimates

USD estimates use on-disk catalogs, resolved provider-first: local overrides → this provider's own catalog
→ LiteLLM → `null`.

```bash
tlc harness prices refresh
tlc harness prices refresh cursor
tlc harness prices refresh litellm
tlc harness prices lookup <model-id> [provider]
```

Details: `tlc harness help prices` (or [/measure.md](/measure.md)).

## capability catalog

Optional features are chosen during the harness-init wizard (see [/init.md](/init.md)) and stored per
project. `tlc harness doctor` WARNs without failing for off/default opt-ins. Enable via harness-init or by
editing `.tlc/harness/config.json` — never auto-enabled.

## observation mode

`observe.enabled` plus `observe.rails`. Runs a rail's checker while that rail is **not** enforcing, and records
the reading without touching the turn.

It exists to answer the one question a firing rate cannot: *was the rule ever needed?* A rail that never fires
while its prose is injected is either working or unnecessary, and the count alone cannot tell you which. Run the
checker with the prose absent and the two separate: if the property holds anyway, the model was already doing it
and the rule is paying for injected context and returning nothing.

| Reading | What it means |
|---------|---------------|
| `held-without-prose` | The model does this on its own. The rule is a candidate for deletion. |
| `held-with-prose` | Ambiguous by construction — this is why observation runs with enforcement off. |
| `violated-without-prose` | The rule is doing real work. Keep it. |
| `violated-with-prose` | The prose is not working. Move the rule to a gate, or accept the rate. |

Observation never returns a decision and never blocks — a measurement that can change what it measures is not a
measurement. An enforcing rail is not observed, because it already records through its own path and counting it
twice would double the readings. Records land under their own obs kind rather than sharing the refusal kind, so
the denial counters stay honest ([/decisions/ad-027.md](/decisions/ad-027.md)).

Only `comments` is observable today. A name with no checker records nothing, and `doctor` says so by name rather
than leaving you to read the silence as "the property always holds" — which is the worst available misreading of a
measurement rail ([/decisions/ad-029.md](/decisions/ad-029.md)).

This is possible because the checker and the instruction are separate things here. In a system where the rule *is*
the mechanism there is nothing to hold apart, and the only alternative — running the same task repeatedly with and
without the rule — needs task repetition that real work does not offer.

## resolution history

When a gate passes after having failed, the harness records the files that changed between those two states against
the failure's fingerprint. If that exact failure returns, the follow-up carries one line naming them.

It is offered as **history, never as instruction**: past tense, and explicit that it is not a list to edit. A
previous resolution is evidence, and evidence is what a plan may name — but the same list phrased as an order would
send an agent to edit files that may be irrelevant this time, which is the harm AD-021 and AD-024 each removed
through a different door ([/decisions/ad-028.md](/decisions/ad-028.md)).

Bounded at 200 resolutions and 8 files each, pruning the oldest, because the store is read on the failure path.
Scoped to this repository: a fix that worked in another codebase is exactly the kind of advice that reads plausible
and is wrong.

## attestation

`tlc harness attest [--json]`. Every session appends one hash-chained record: which policy was in force, whether it
changed mid-session without a harness command, which rails were active, refusals by rule, and gate outcomes.

That is the artifact a reviewer needs in order to trust agent-written code, and it is the part governance-as-prompting
never produces. Verification reports the index at which the chain broke, so a tampered record sends you to one line
rather than to the whole file. A missing file is an empty valid chain, not a broken one.

Two things it deliberately does **not** claim. It is chained, not signed — that detects a rewritten or removed
record and does not prove authorship, because a key would mean key management. And every field is something the
harness observed: there is no assertion that the code is correct, that anyone reviewed it, or that a human approved
anything. An attestation implying those would be worse than none, because a reviewer would stop looking
([/decisions/ad-028.md](/decisions/ad-028.md)).

## accepting a policy edit you made

If you edit `config.json`, a flag file or the mode file while a session is live, the next acting tool call in that
session is refused and the changed path is named. That is the integrity check working: a mid-session policy change
with no harness command behind it is what it exists to catch.

```bash
tlc harness policy                      # list what changed, change nothing
tlc harness policy accept <path>...     # accept exactly those paths
```

Four things keep that second command out of an agent's reach, and no single one carries the weight
([/decisions/ad-030.md](/decisions/ad-030.md)):

- the floor refuses `tlc harness policy` from inside any agent session, with no config switch
- it refuses without an interactive terminal, so a script cannot reach it either
- you name each path, so accepting is an act rather than a keystroke
- acceptance is per source, so anything you leave out keeps blocking

Accepting records the hash as it is now. A later change to the same file diverges again — there is deliberately no
way to say "stop watching this". And the acceptance is recorded rather than erased, so a reviewer reading the
session's attestation sees that policy moved and was accepted, instead of seeing nothing.

`status` and `doctor` never clear a divergence as a side effect of looking at it. `doctor` reports one when it
exists, naming the paths and the command.

## updating

```bash
tlc harness version          # which revision you run, and what this project last saw
tlc harness update --check   # what an update would pull. Fetches; never merges
tlc harness update           # pull, relink, rebuild, announce what landed, then doctor
```

There is no changelog file and no version number, on purpose. The version is the runtime's git revision and its
date, because that is what `update` actually moves — a hand-maintained number drifts, and this one said `0.1.0` for
the project's whole life. A semantic version is a promise about compatibility that AD-003 declines to make.

The changelog is `docs/decisions/`. A decision carries a `migration` note **only when `doctor` cannot detect the
condition for you** — `update` runs `doctor` at the end, so a note that says "run doctor" is noise, and an alarm that
fires on every update is one you learn to scroll past ([/decisions/ad-034.md](/decisions/ad-034.md)). Today exactly one
decision carries a note: the ship gate's evidence ordering, which shows up as a blocked stop and nothing can see in
advance. A project updating for the first time records where it stands
and announces nothing, because thirty entries at once is the same as no message
([/decisions/ad-031.md](/decisions/ad-031.md)).

`doctor` is the net underneath: a posture that fell back, an observed rail with no checker, a policy that changed out
of band. If a migration note was forgotten, that is where it surfaces.

If the fast-forward fails, the runtime checkout has commits upstream does not. The message names both ways out —
reset to upstream, or re-run the installer — and runs neither, because the first one throws work away.

## wiring health

`tlc harness doctor` checks each provider's hooks, and for the replace-strategy target it checks them **per event**:
our launcher named in the command, that file present on disk, and a handler after it. A declared event with no
harness entry is reported too — that is the case a marker cannot see.

The marker keeps its own job, unchanged: it answers *is this file ours*, which is what decides whether `update` may
overwrite it. Whether the hooks work is a different question, and conflating the two is what let a hook that could
not run report as healthy ([/decisions/ad-032.md](/decisions/ad-032.md)).

A hook belonging to another tool in the same file is never reported. That is deliberate — flagging someone else's
entry would train you to skip the check, and then it would miss ours.

When something is wrong the detail names the event and the reason, bounded to three with a count of the rest:

```
WARN  cursor wiring — detected but not wired — preToolUse: no handler after the
      script: `node /path/tlc-exec.mjs` — run: tlc harness update (~/.cursor/hooks.json)
```

## writing a lesson yourself

The store used to have one producer: the same gate failing twice. So anything learned another way — a review, an
incident, a pattern you noticed across several changes — could not enter the one channel built to carry it back to the
next turn.

```bash
tlc harness lessons add "Grep for a producer before calling a new field done." --tokens producer,dead
tlc harness lessons add "Re-run the suite after the last edit." --gate test --avoid "citing a stale verdict"
```

It is recorded as `source: manual` and active immediately — a candidate exists because the automatic producer is
guessing from gate output, and an author is not. The id is a hash of the instruction, so rewriting the same lesson
updates it instead of adding a near-duplicate. A lesson written from inside an agent session says so in its category,
so you can tell the two apart in `tlc harness lessons list`.

**Say what makes it true, and it retires itself.** `--ref path[:symbol]` names the thing the lesson is about; when
that stops resolving the lesson is withheld instead of sending the next turn after a file that no longer exists.
`--until <iso>` gives it an end date. Both are optional and a lesson about conduct needs neither.

```bash
tlc harness lessons add "Run tools/check-dist-fresh.ts before the commit, never chained with &&." \
  --ref tools/check-dist-fresh.ts --gate test
tlc harness lessons add "Pin the formatter until the toolchain moves." --until 2026-12-01T00:00:00Z
```

**Decide who should read it.** A lesson about this repository stays here; one about engineering belongs to every
product you work in. `--global` writes it to the machine tier, and `lessons promote <id>` moves an existing project
lesson up. Nothing is promoted automatically — a lesson mined from one product's gate names that product's tooling
([/decisions/ad-040.md](/decisions/ad-040.md)).

```bash
tlc harness lessons add "Run the gate itself, never an approximation of its steps." --global
tlc harness lessons promote project:test:9f2c1a
```

**The harness never reads your documentation to find lessons.** No decision-record convention, no directory, no file
format — it runs in many products, and one project's filing habits are not a feature of the tool. If you want your own
ADRs or postmortems to produce lessons, that is a script in your repository calling this command
([/decisions/ad-035.md](/decisions/ad-035.md)).
