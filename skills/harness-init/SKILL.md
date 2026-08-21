---
name: harness-init
description: Mandatory interactive wizard to connect a repo to the global harness (writes .tlc/harness/config.json + shim hooks via tlc-exec, for whichever of Cursor / Claude Code are installed). Use when the user says setup harness, init harness, enable harness, ligar o harness, bootstrap harness, configure harness for this repo, or wants lessons/grind/shipGate policy chosen with trade-offs. Do NOT use for status (tlc harness status), expert Q&A (tlc harness help), grind/mode toggles alone, or explaining metrics (send those to tlc harness help).
license: CC-BY-4.0
metadata:
  author: Felipe Rodrigues
  version: 1.0.0
---

# Harness init (mandatory project wizard)

Connect the **global** harness runtime to **this** repo, for whichever providers are actually installed
(Cursor, Claude Code, or both). The skill is required for setup; **each capability is optional** and must
be chosen with benefit / trade-off / default.

Help SoT is CLI docs (`tlc harness help <topic>`), not this skill. For Q&A only, stop and send the user to
`tlc harness help`.

## Instructions

### Step 1: Preconditions

1. Run `tlc harness doctor` and `tlc harness help init`.
2. If global runtime checks FAIL (Node 24+, `dist/`, `tlc-exec`), stop and fix the global install
   (`tlc harness build`, PATH link) before project policy.
3. Detect which providers are installed. **Resolve the directories, do not assume them**: Claude Code
   honours `CLAUDE_CONFIG_DIR` and Cursor honours `CURSOR_CONFIG_DIR`, so a relocated config is common
   and wiring the default path would write a file the agent never reads. `tlc harness doctor` prints the
   resolved target for each provider — read it from there rather than guessing. Tell the user which
   provider(s) will be wired. Never assume Cursor: a Claude-only machine has no Cursor directory at all.
4. If `.tlc/harness/config.json` already exists, show it and ask: **overwrite**, **merge**, or **abort**.

### Step 1b: Hook runtime (ask once, never block)

Hooks fire on every tool call, shell command, file read and stop — dozens per agent turn — so the runtime
that launches them dominates their cost, regardless of which provider is in use.

Check whether **Bun** is on `PATH`.

**Bun present** → say so in one line and move on.

**Bun absent** → present it as a trade-off, not a warning, with the measured numbers:

```
Hook runtime: Node (Bun not found)
  Bun runs each hook in ~1ms; Node needs ~27ms.
  At ~30 hooks per turn that is ~30ms vs ~810ms of startup.
  Install: curl -fsSL https://bun.sh/install | bash
  Node works fine — just slower. Continue on Node?
```

Rules:

- **Never block.** Node is fully supported. The question is "continue?", not "install first".
- **Never ask twice.** Record the answer in the project's harness state; on later runs skip this step.
  `doctor` keeps reporting it as a non-failing `WARN`.
- **Always give the number.** "~1ms vs ~27ms" lets the user decide; "faster" gets ignored.
- If the user installs Bun mid-wizard, re-check before continuing rather than trusting the earlier probe.

### Step 1c: State the floor once (no question attached)

Before offering any choice, tell the user what holds regardless of configuration. Read the
**Not configurable** table in `references/capabilities.md` and state it in two or three lines. This is not
a question and nothing here is optional; skipping it means their first denial looks like a defect.

### Step 2: Discovery (never skip)

Read `references/capabilities.md` **now** (full menu + lessons automation table).

Work **one capability at a time** from that catalog. For each: name → benefit → trade-off → default → ask
yes/no → if yes, collect values. Stay stack-agnostic.

When presenting **Subagent allowlist** (capability 6), also present **Block parent Fast** (capability 6b /
`subagents.blockParentFast`, default **off**) from `references/capabilities.md` in the same pass: benefit →
trade-off → default → ask yes/no. Write `blockParentFast: true` only if the user accepts.

If the user accepts the allowlist, **collect the model slugs from them**. The harness ships no catalogue, and
`enforceAllowlist: true` with an empty `allowedModels` enforces nothing — `doctor` reports it as a fault. Do not
propose slugs: a suggested list is a shipped default one conversation later, and the one that used to be shipped is
exactly what went stale ([/decisions/ad-053.md](/decisions/ad-053.md)). Tell them the values their provider accepts
are in its own model picker, that a variant suffix such as `-thinking-high` needs its own entry, and that `inherit`
is a value the list may contain. If they accept the capability but have no list ready, write
`enforceAllowlist: false` and say why.

Do **not** enable anything the user did not accept. Do **not** invent stack commands.

### Step 2b: Comment gate — four choices, ask explicitly

Agents narrate. Prose in an instruction file does not stop it, so this is the deterministic gate.
It compares added lines against the commit the turn started from, so comments already committed are
never flagged — and a turn that commits its own work cannot move the base past its own lines.

Present all four and let the user pick:

```
off         — no comment gate. Anything the agent writes lands.
declared    — an added comment must declare a reason: why: / hazard: / invariant:
              Narration is blocked; a real hazard can be recorded without interrupting you.
              Cost: a marker prefix no other codebase uses.
resolvable  — declared, plus the question a marker cannot answer: can a reader who was not
              in this session check the comment? Blocks change narration ("this used to"),
              citations only the session saw ("(decision 3)", "per the plan"), PR vantage
              ("this PR"), and comments arguing their own correctness.
              Cost: a phrase-level rule, so it refuses some sentences that were fine.
strict      — no agent-added comments at all. If one is warranted the agent says so in
              its reply and you write it. Cost: interrupts more; zero invented convention.
```

Write `comments.enabled: false` for **off**, or `comments.enabled: true` with
`comments.mode: "declared" | "resolvable" | "strict"`. Default is off, like every other capability.

In every mode a `/** */` comment attached to a declaration is judged differently: it does not need a
marker, but it must say something its identifier does not already say. A floating `/** */` inside a
function body is not attached to anything, so it counts as an ordinary comment.

Tool directives (`biome-ignore`, `@ts-`, `noqa`, `shellcheck`, shebang) are exempt in every mode.

### Step 2c: Idle-turn gate (capability 17 — offer it, default off)

The mode lines tell the agent not to interrupt for reversible work, but that is prose and prose is
probabilistic. This is the deterministic half.

It blocks the stop when a turn ends with open handoff work, **zero recorded tool calls and zero file
changes**. It counts events the harness already recorded — it never reads or judges the agent's reply,
so there is no wording that satisfies it. Works on both providers, since both fire tool hooks.

Ask yes/no. Default off. Turn it off for conversational repos where answering without touching files
is a normal turn.

### Step 2d: Docs staleness gate (capability 18 — offer it, default off)

Code changes pass lint, tests and the ship gate; the documents describing them pass nothing. This gate runs
**the repository's own** staleness tool on stop, the same way grind runs its lint and test. The harness does
not infer staleness from paths: mapping directories to documentation was measured reporting on 82–100% of
commits, which detects nothing.

So the question is which tool the repository has, not which globs to write. Look for evidence before asking:

```
drift.lock, .drift/           → drift (AST anchors; command is usually: drift check)
openapi.yaml + oasdiff in CI  → oasdiff (usually: oasdiff changelog <base> <head> --fail-on-diff)
sgconfig.yml, ast-grep rules  → ast-grep (usually: ast-grep scan)
a docs script in package.json → that script
```

Ask, in this order:

1. Is there such a tool? If the repository has none, **say so and leave the capability off.** A gate with
   nothing to run is not worth configuring, and inventing a command is worse than no gate.
2. If there is one, ask for the exact argv array. Never guess flags.
3. `warn` or `deny`. Default `warn`; reserve `deny` for a surface where a stale document is actively harmful.

The tool owns its own escape hatch — `drift` requires an explicit confirmation that the document was read
before re-stamping — so the harness adds no skip token of its own.

### Step 2e: Operator rules — the switch is half of it (capability `operatorRules`, default off)

Every other capability is a boolean. This one is a boolean **plus at least one markdown file**, and
`rules.enabled: true` with no file enforces nothing — the same shape as `enforceAllowlist: true` with an empty
list. `doctor` reports that state rather than staying silent, but do not leave the user there.

If they accept the capability, ask what the standing requirement actually is, then write the first rule with them.
The vocabulary is closed, so read it out rather than inventing terms:

```
on:         pr-open | commit | push | stop | tool(<name>) | command(<pattern>)
require:    subagent(<type>) | command(<pattern>) | gate(<name>) | file(<glob>)
            each since HEAD (default) or since session
otherwise:  deny | ask | follow-up | warn
```

A rule is one file in `<repo>/.tlc/harness/rules/<name>.md` for the team, or in the runtime home's `rules/` for
every repository on this machine. The frontmatter is enforced; the body is their own text, injected verbatim when
the rule fires. Full grammar and the verdict matrix: `tlc harness help rules`.

Two things to say out loud, because both surprise people later:

- **The proof has to be something the harness observed** — a subagent that ran, a command that completed, a gate
  that passed, a file that changed. It cannot judge whether the review was any good, and the agent cannot create
  a proof: that store is under the project state directory, which the floor refuses it.
- **`since HEAD` means a new commit makes an old proof stale**, and a project with no git checkout cannot satisfy
  `since HEAD` at all.

If they accept the capability but have no requirement in mind, write `rules.enabled: false` and say why — a switch
with no file is the shape that looks like protection and is not.

### Step 3: Confirm

Show the **full proposed** `.tlc/harness/config.json` in a fenced block (English keys/strings only). Ask
explicit confirmation before writing.

### Step 4: Write

Only after confirmation:

1. Prefer: `echo '<policy-json>' | tlc harness init --write --stdin-json`
2. If that fails: write `.tlc/harness/config.json` yourself; `tlc harness init --minimal` only as last
   resort for hooks/gitignore, then re-apply the agreed policy.
3. Shim hooks must call `$HOME/.tlc/harness/bin/tlc-exec shim <handler>` (never `bun run …/src/*.ts`
   directly, and never a bare `harness-exec` from the predecessor layout).
4. `tlc harness init` writes project shim hooks only for providers detected present, using the config
   directory each provider actually resolves to — the defaults are `~/.cursor` and `~/.claude`, but
   `CURSOR_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` override them and a relocated config is common. Take the
   resolved paths from `tlc harness doctor` rather than assuming either default.
5. Ensure `.gitignore` covers `.tlc/harness/state/`.
6. If `intelligence.lessons.enabled` is true and `syncRulesFile` is not `never`, run `tlc harness lessons
   sync-rules` once after write. Under the default `auto` the durable view is written where the provider does not
   deliver hook context, so do not ask the user to choose a transport — ask only whether they want the file at all.
7. Run `tlc harness status` and `tlc harness doctor`.
8. Tell the user: reload/restart the provider session if hooks were new; next agent turn should set
   `TLC_ACTIVE`; day-to-day help is `tlc harness help`.

**Never** create `<repo>/.cursor/commands/` or an equivalent project-local commands directory for harness
slash commands — keep provider-native commands global.

### Step 5: Explain automation (if lessons or grind enabled)

State clearly what runs **without further prompts**:

- Grind/ship/comments/intelligence rails fire on **stop** / **sessionStart** via hooks, on every wired
  provider.
- Ship gate (when enabled) reacts **only** to an explicit `HARNESS_SHIP_CLAIM: …` line — free-English
  "done/shipped" is ignored. Prefer `runtimePathExcludes` (defaults include `.tlc/`, `.cursor/`, `.claude/`)
  over pausing gates forever.
- Lessons (when enabled): auto-record on **stagnation**, auto-inject on start/retry, auto-garden on
  sessionEnd; the provider-native durable view (Cursor's `.cursor/rules/harness-lessons.mdc` or Claude's
  `CLAUDE.md` import line) syncs only if configured.
- Enabling capabilities is never automatic — only what the user opted into during discovery.

## Examples

### Example 1: New repo, Cursor only

User: "setup harness here"
Actions: doctor → detect Cursor installed, Claude Code not → read capabilities.md → one-by-one opt-in →
confirm JSON → `tlc harness init --write --stdin-json` → status/doctor
Result: policy + Cursor shim; features only where user said yes

### Example 2: Repo already used with Claude Code, enabling lessons

User: "ligar lessons no harness deste repo"
Actions: show current `.tlc/harness/config.json` → explain auto record/inject/garden + `syncRulesFile`
trade-off → merge `intelligence.lessons` → confirm → write → `tlc harness lessons sync-rules` if sync on →
doctor
Result: lessons enabled; no unrelated feature flips; only Claude's `CLAUDE.md` import line is touched,
since Cursor is not installed on this machine

### Example 3: Wrong skill

User: "how do I see harness metrics?"
Actions: do **not** run init; tell them `tlc harness help measure`
Result: no files written

## Troubleshooting

### Error: tlc not found

Cause: the bin directory is not on PATH. `tlc harness install` links the command there and says so when that
directory is unreachable — read the install output.
Solution: add that directory to PATH, or re-run `tlc harness install`.

### Error: doctor fails Node / dist

Cause: neither Bun nor Node 24+ is available, or the bundles are missing.
Solution: either is enough — `curl -fsSL https://bun.sh/install | bash`, or Node 24 LTS / 26 Current from
nodejs.org. Bun needs no build step; on Node run `tlc harness build`. Reload the editor session afterwards.
Doctor reports an old Node as `OK` when Bun covers it, so check the `hook runtime` line too.

### Error: doctor fails global runtime

Cause: incomplete `~/.tlc/harness` or hooks still pointing at a predecessor path (`~/.cursor/agent-harness`,
`harness-exec`).
Solution: fix global hooks to `tlc-exec` under `~/.tlc/harness`; rebuild dist.
