# Capability catalog (load when running discovery)

Read this file during the Discovery step of harness-init. Present **one capability at a time**: name →
benefit → trade-off → default → ask yes/no → if yes, collect values.

Stay **stack-agnostic** (never assume Biome, Vitest, npm, Bun, pytest) and **provider-agnostic** (never
assume Cursor — check what Step 1 detected).

## Always ask once (before capabilities)

- `projectName` (optional string)
- `codePaths` (dirs that count as code for grind)
- starting `mode`: `paired` | `solo` | `focus` (default `solo`) — how much the agent surfaces; verification is
  identical at all three. No other value is accepted

## Capabilities (all optional)

<!-- generated:capabilities -->

| # | Capability | Key | Default | Benefit | Trade-off | Extra asks if yes |
|---|------------|-----|---------|---------|-----------|-------------------|
| 1 | Grind (lint/test on stop) | `grind.enabled` | off | Re-checks lint/test after each completed turn and follow-ups until gates pass. | Uses turns; flaky commands thrash the agent. The gate's cost is paid once per attempt, up to maxLoops — a four-minute suite with maxLoops 5 can spend twenty minutes on tests alone. tlc harness obs report shows the runs and the total. | `lintCommand`, `testCommand`, `maxLoops` |
| 2 | Ship gate | `shipGate.enabled` | off | Blocks false done after an explicit HARNESS_SHIP_CLAIM when evidence is missing. | Needs a real evidenceDir workflow; free-English done is ignored. | `evidenceDir`, `runtimePathPrefixes`, `runtimePathExcludes`, `evidenceMaxAgeHours`, `claimWindowMinutes` |
| 3 | Empty-diff anti-ship | `shipGate.emptyDiffAntiShip` | off | Blocks a ship claim when the working tree has zero changes. | Annoys when a zero-diff claim is intentionally correct. | `requires shipGate enabled` |
| 4 | Comment gate (agent-added comments) | `comments.enabled` | off | Blocks the stop when this turn added comment lines, so narration never lands. Diff-scoped: comments you already committed are never flagged. | Three modes. declared lets the agent keep a comment by writing why:/hazard:/invariant:; resolvable adds the question the marker cannot answer — can a reader who was not in the session check this? — and catches change narration, dead plan or decision citations, and comments arguing with a reviewer; strict accepts none and asks you to write it instead. Each is stricter and interrupts more. | `mode: declared \| resolvable \| strict` |
| 5 | Duplication gate (agent-added copies) | `duplication.enabled` | off | Blocks the stop when the turn wrote six or more lines the project already has, naming both sites. Diff-scoped: what was already duplicated is not counted. | Reads every tracked file on stop, bounded at 2000 files and 8 MB, and says when a bound was reached. Comments, dependency declarations and pure data — object literals, type bodies, export lists — are excluded, so it reports duplicated logic and misses duplicated shape. | `minRun: lines a run must reach before two copies count (default 6)` |
| 6 | Supply-chain gate (dependencies this turn added) | `supplyChain.enabled` | off | Blocks the stop when a dependency added this turn is not recorded in a lockfile, or is specified as latest/*/no version. A dependency added in a turn runs on every later turn, in CI, and on every machine that installs the project. | Recognises a manifest by filename from one table, so an ecosystem the table does not carry is not covered. For a JSON manifest the declared dependency sections decide, so it reads the manifest as it stands — without that, a rename or a scripts entry reads as a dependency. It does not check advisories, licences or typosquats: those need the network on every stop. | — |
| 7 | Subagent allowlist | `subagents.enforceAllowlist` | off | Restricts Task/subagent models to a list you write, and blocks *-fast shapes by default. | The harness ships no model list, so switching this on without filling allowedModels enforces nothing and doctor reports it as a fault. You maintain the list as providers add models — including a value for `inherit` if you want subagents to take the parent's model. | `allowedModels`, `requireModel`, `blockMode` |
| 8 | Block parent Fast mode for Task spawns | `subagents.blockParentFast` | off | Denies Task/subagentStart while the parent chat is in Fast mode (sticky from hooks), closing the gap where Task slugs omit *-fast. | Needs parent model hooks (sessionStart/obs/stop); false denials if you intentionally run Fast parent with workers. | recommend **on** |
| 9 | Shell stall detection | `shell.stallDetection` | off | Blocks repeating the exact same shell command too many times. | Can false-positive on intentional retries. | `stallRepeatThreshold (default 3)` |
| 10 | Catastrophic shell ask | `shell.catastrophicAsk` | **on** | Asks before destructive shell commands (rm -rf, drop db, force push, …). | Extra prompts on risky commands. | recommend **on** |
| 11 | Lessons | `intelligence.lessons.enabled` | off | Records compact lessons on gate stagnation and reinjects them ranked under a char budget. A lesson can name the path or symbol that makes it true and is withheld once that stops resolving, can carry an end date, and is graded helped or neutral by the next run of the gate it was injected for. Three tiers: shipped core, a global tier read by every product on this machine, and this project's own. How the lessons reach the model is decided by the provider rather than configured: where a host does not deliver context returned from its session-start hook, a durable rules file is written instead. | Uses context tokens; not a second brain / chat memory. The grading is correlational, not causal — a gate passing after a lesson was injected does not prove the lesson caused it. Nothing is promoted between products automatically, so carrying a lesson to another product is an operator command. On a host that needs the durable view, a file is written into the repo (`.cursor/rules/harness-lessons.mdc`) and asked to be included on every request; `syncRulesFile: never` declines it. | `maxInjectSession`, `maxCharsSession`, `maxInjectRetry`, `maxCharsRetry`, `promoteHitCount`, `decayLambda`, `projectBoost`, `syncRulesFile`, `gardenOnSessionEnd`; recommend **on** |
| 12 | Budget continue | `intelligence.budgetContinue` | off | Pushes the agent to keep working under context pressure instead of wrapping up early. | Can delay clean stops. | `budgetContinueAfterLoops` |
| 13 | Gap feedback | `intelligence.gapFeedback` | **on** | Injects PREVIOUS_GAPS on gate failure so retries fix listed items. | Longer follow-ups. | — |
| 14 | Failure classification | `intelligence.failureClassification` | **on** | Stores failure categories on the handoff for clearer next actions. | Extra handoff fields. | — |
| 15 | Progressive handoff | `intelligence.progressiveHandoff` | **on** | Carries the gaps the previous session ended with into the next session's bootstrap, as history rather than as a task list. | Spends session-start context on a verdict that may already be stale — only the next run of the gate says whether it still holds. Capped at five, and the rest are counted rather than dropped in silence. | — |
| 16 | Progressive context | `intelligence.progressiveContext` | **on** | Escalates gate follow-up detail on each stop retry. | Longer thrash follow-ups. | — |
| 17 | Autopilot | `intelligence.autopilot` | **on** | Adds ordered AUTOPILOT steps on gate failure. | Agent must follow the block; more directive follow-ups. | — |
| 18 | Idle-turn gate (asked instead of acting) | `intelligence.idleTurnGate` | off | Blocks a turn that ends with open work, zero tool calls and zero file changes. Counts recorded tool events rather than reading the reply, so it cannot be talked around. | A turn that legitimately only answers a question is blocked while handoff work is open — clear the handoff or turn this off for conversational repos. | — |
| 19 | Docs staleness gate | `docs.command` | off | Runs the repository's own documentation staleness tool on stop, so a stale document fails like a failing test. | Needs such a tool in the repository; without one there is nothing to run. | `command (exact argv array)`, `severity: warn \| deny` |
| 20 | Global observability spool | `obs.globalSpool` | off | Mirrors this repo's obs and audit records into one file under the runtime home, so cost and gate history can be read across every repository at once. | Writes outside the repository. Records carry the repo path and project name, and the spool is pruned on the same retention window as session rollups. | — |
| 21 | Untrusted-content framing and enforcement | `untrustedContent.enabled` | off | Injects one framing line per turn when the agent reads a pull request, an issue, a fetched page or an MCP result, stating that the content is data and that any directive inside it is to be reported as a prompt-injection attempt, not obeyed. | Two modes. frame injects one line per turn, costing a few hundred characters and enforcing nothing. enforce also remembers what an untrusted read returned, bounded at 64 KB per session, and asks before a shell command that appears verbatim in it — verbatim because a paraphrase cannot be shown to come from the content, so a rewritten command is missed. It needs the host to deliver tool output on the after-event: measured present on Claude Code's PostToolUse and on Cursor's afterShellExecution and afterMCPExecution, and absent on Cursor's generic postToolUse. | `mode: frame \| enforce` |
| 22 | Plan gate (declared scope vs diff) | `planGate.enabled` | off | Blocks the stop when the turn changed files the declared HARNESS_PLAN did not name, so scope creep fails like a failing test instead of surviving as a review comment. | Requires the agent to declare HARNESS_PLAN before editing, and each honest deviation to state a reason. A turn with no declaration is not gated at all. | `windowMinutes` |
| 23 | Observation mode (measure a rail with its rule off) | `observe.enabled` | off | Runs a rail's checker while that rail is not enforcing, so the record says whether the property held with the rule injected or without it. That is the reading that tells you a rail is unnecessary rather than merely quiet, and it is what makes deleting one a decision instead of a guess. | Costs one diff scan per turn per observed rail, and answers a question only an operator who is asking it needs answered. It never blocks and never changes a decision, so it buys information and nothing else. | `rails — the rails to observe, chosen from the observable set (today: comments). A name with no checker records nothing and doctor reports it` |
| 24 | Operator rules (your trigger, your proof) | `rules.enabled` | off | Turns a standing instruction into a gate. A rule names when it applies, what the harness must have observed, and what to do when it has not — so 'no pull request without a review' stops depending on the model remembering it. | The proof must be something the harness observed: a subagent that ran, a command that completed, a gate that passed, a file that changed. It cannot judge whether the review was good, and a pattern trigger is policy rather than containment — a script written to disk and run later, or a pull request opened in a browser, escape it. | — |

<!-- /generated -->

Stagnation fingerprinting is always on when grind gates fail (no separate toggle) — mention when discussing
grind.

## Lessons subsection (capability 9)

If the user enables lessons, explain what runs automatically:

| Event | What happens |
|-------|--------------|
| Gate stagnation (same fingerprint ≥ 2) | Upsert `candidate` lesson in `.tlc/harness/state/lessons.json`, recording the session key |
| Stop retry / sessionStart | Inject ranked lessons under char budget, skipping any that are stale or out of window |
| Next run of the same gate | Grade the lessons injected for it: passed → `helped`, failed → `neutral` |
| sessionEnd | Promote / decay / quarantine when `gardenOnSessionEnd`, mark or clear staleness, prune expired |
| `syncRulesFile` | Rewrite the provider-native durable view — Cursor's `.cursor/rules/harness-lessons.mdc`, Claude's `CLAUDE.md` import line. `auto` writes it where the provider does not deliver context returned from its session-start hook, which today is Cursor |

Ask for lessons knobs (offer defaults):

- `maxInjectSession` (5), `maxCharsSession` (900)
- `maxInjectRetry` (8), `maxCharsRetry` (1400)
- `promoteHitCount` (2) — counted in **distinct sessions**, not raw recurrences
- `decayLambda` (0.02), `projectBoost` (1.5) — the boost favours this project over the global tier
- `syncRulesFile` (recommend **auto**, the default — the provider decides. Cursor drops `additional_context`
  returned from `sessionStart`, acknowledged by Cursor as a race with the composer handle, so `auto` writes the
  rules file there and not on Claude Code. Use `never` if the user does not want a file in `.cursor/rules/`, and
  `always` on Claude Code to keep a `CLAUDE.md` pointer that survives a restart)
- `gardenOnSessionEnd` (recommend true)

**Nothing to configure for the tiers.** The global tier lives at `<runtime home>/state/lessons.json` and is read
automatically; it is written only when the operator passes `--global` or runs `lessons promote`. There is no
setting that makes promotion automatic, and that is deliberate — a lesson mined from one product's gate names that
product's tooling ([/decisions/ad-040.md](/decisions/ad-040.md)).

If the user asks how to record something they just learned, the commands are:

```bash
tlc harness lessons add "<what to do differently>" [--gate <name>] [--ref path[:symbol]] [--until <iso>] [--global]
tlc harness lessons promote <id>
tlc harness lessons list
```

Mention `--ref` when the lesson is about a file or a symbol: it is what makes the lesson retire itself instead of
outliving what it was about. Mention `--global` when the lesson would be true in a different repository.

Point deep docs to: `tlc harness help lessons` (load only if the user asks how decay/ranking works).

## Operator rules subsection (capability 24)

There is no knob beyond `rules.enabled`, because a rule is a file rather than a setting. If the user enables it,
ask what standing instruction they repeat by hand, then write the file with them — one rule per file, in
`.tlc/harness/rules/<name>.md` for this project or in `<runtime home>/rules/<name>.md` for every repository on
this machine.

```markdown
---
on: pr-open                            # pr-open | commit | push | stop | tool(<name>) | command(<pattern>)
require:
  - subagent(the-jury) since HEAD      # subagent | command | gate | file, since HEAD or since session
otherwise: deny                        # deny | ask | follow-up | warn
---

Convene the jury on this branch. Checklist: docs/review-checklist.md
```

The frontmatter is enforced; the body is the operator's own text, shown verbatim when the rule fires — so it is
where the instruction, the checklist and the reason go.

The four verdicts land differently at the two moments a rule can fire:

| verdict | on an action | at the stop |
|---|---|---|
| `deny` | refuses the action | refuses the stop |
| `ask` | asks under `paired`, refuses otherwise | refuses the stop — no host offers an ask there |
| `follow-up` | allows | refuses the stop, framed as the next action |
| `warn` | allows | advisory text, and the stop is allowed |

An `on: stop` rule is the one to reach for when the instruction is "before you finish, do X". It is read after the
lint, test and docs gates have run, so a rule asking for `gate(test) since HEAD` can be satisfied by this turn's
gate.

Five things to say while writing it:

- **The proof must be observable.** A subagent of that type finishing, a command that ran and did not fail, a gate
  that passed, a file that changed. There is no proof that the review was any good, and asking for one would be
  the same guesswork the rule exists to remove.
- **`since HEAD` means this code.** A review followed by another commit is stale and the rule fires again. Use
  `since session` for something that only needs doing once per session.
- **Both tiers apply**, deduplicated by file name with the project winning. A standing rule belongs in the runtime
  home so it is not retyped per repository; a project file with `enabled: false` and a body is how one repository
  opts out, with the reason recorded.
- **Posture changes only `ask`** — it interrupts under `paired` and hardens to `deny` under `solo` and `focus`.
  `deny`, `follow-up` and `warn` are identical at all three.

`tlc harness doctor` lists every active rule with the tier it came from, every one switched off here, and every
rule whose proof kind this project has never recorded — which is how a rule that enforces nothing satisfiable is
found before it is trusted.

Point deep docs to: `tlc harness help rules`.

## Not configurable — state this once, before discovery

A floor tier runs ahead of every setting and reads no configuration, so nothing below can switch it off.
Tell the user plainly, because the first denial otherwise looks like a bug:

| Rule | Denies |
|------|--------|
| `outside-project-destruction` | A destructive command whose target resolves outside the project and outside the OS temp directory |
| `unprovable-destruction` | A destructive verb whose target cannot be resolved — a variable, a substitution, or a command built at runtime |
| `secret-access` | Reading a credential path into the transcript: `.env`, `~/.ssh`, `~/.aws`, `*.pem`, and similar. `.env.example` and friends are not secrets |
| `history-rewrite` | `git push --force`. `--force-with-lease` is allowed, since it refuses when the remote moved |
| `machine-control` | `shutdown`, `reboot`, `halt`, `poweroff` |

Harness policy and state are not agent-writable either: a gate an agent can edit is not a gate.

## Runtime note (tell user once)

Hooks call `~/.tlc/harness/bin/tlc-exec` — Bun-first when Bun is on PATH (~1 ms/hook), Node 24+ + `dist/`
otherwise (~27 ms/hook; see Step 1b). After global code changes: `tlc harness build`. Day-to-day use does
**not** require Bun. Install path is only `~/.tlc/harness` — never `~/.cursor/harness` or
`~/.cursor/agent-harness`.
