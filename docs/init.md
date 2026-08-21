---
type: Runbook
title: "Init (project bootstrap)"
description: "What tlc harness init creates, what it deliberately does not do, and the mandatory harness-init wizard's capability menu — including the Bun-vs-Node hook runtime question."
tags: [runbook, init, wizard]
timestamp: "2026-07-29"
---

# Init (project bootstrap)

## What init creates (project-agnostic)

| File | Purpose |
|------|---------|
| `.tlc/harness/config.json` | Policy for this repo only |
| `.cursor/hooks.json` | Cursor shim to the global runtime — only written when `~/.cursor` is detected |
| `.claude/settings.json` (`hooks` block, merged) | Claude Code shim — only written when `~/.claude` is detected |
| `.gitignore` entries | `.tlc/harness/state/` |

`tlc harness init` detects which providers are installed (presence of `~/.cursor`, `~/.claude`) and wires
only those — it never assumes Cursor. See `tools/init-project.ts` and
[/providers/index.md](/providers/index.md).

## What init does NOT do

- Does not install the global runtime (assumes `~/.tlc/harness` already present)
- Does not assume Biome, Vitest, npm, or any stack
- Does not enable grind/shipGate/etc. unless the user opts in during discovery

## Wizard rule

The **harness-init skill is mandatory** for project setup. **Each capability is optional** — the wizard
must present benefit / trade-off / default and ask before enabling.

## Step 1b: hook runtime (ask once, never block)

Before the capability menu, the wizard checks whether **Bun** is on `PATH` and presents the measured
trade-off from [/decisions/ad-012.md](/decisions/ad-012.md):

```
Hook runtime: Node (Bun not found)
  Bun runs each hook in ~1ms; Node needs ~27ms.
  At ~30 hooks per turn that is ~30ms vs ~810ms of startup.
  Install: curl -fsSL https://bun.sh/install | bash
  Node works fine — just slower. Continue on Node?
```

Rules: never block (Node is fully supported), never ask twice (the answer is recorded in project state so
later runs skip this step; `doctor` keeps reporting it as a non-failing `WARN`), always give the exact
numbers, and re-probe if the user installs Bun mid-wizard rather than trusting the earlier check.

## Capability menu (for the skill wizard)

| Capability | Keys | Default | Benefit | Trade-off |
|------------|------|---------|---------|-----------|
| format | `format.*` | off | Consistent style on Write | Needs a correct format command |
| grind | `grind.*` | off | Lint/test follow-ups on stop | Turn cost; flaky commands thrash |
| shipGate | `shipGate.*` + `HARNESS_SHIP_CLAIM` | off | Honest ship after protocol claim | Needs evidence workflow; free English ignored |
| emptyDiffAntiShip | `shipGate.emptyDiffAntiShip` | off | No claim on empty tree | Annoys when zero-diff is correct |
| comments | `comments.*` | off | Junk-comment follow-ups | Noise on dirty trees |
| subagents | `subagents.*` | off | Model allowlist / require model | Maintain the list |
| blockParentFast | `subagents.blockParentFast` | off | Deny Task/subagent while parent is Fast | Needs sticky parent hooks; blocks intentional Fast parent |
| catastrophic shell | `shell.catastrophicAsk` | on | Ask before destructive shell | Extra prompts |
| shell stall | `shell.stallDetection` | off | Block repeated identical commands | False positives on retries |
| gap feedback | `intelligence.gapFeedback` | on | Structured PREVIOUS_GAPS | Longer follow-ups |
| failure classification | `intelligence.failureClassification` | on | Failure categories in handoff | Extra fields |
| progressive handoff | `intelligence.progressiveHandoff` | on | Gaps injected on next session | Slightly longer bootstrap |
| progressive context | `intelligence.progressiveContext` | on | Escalates context on each stop retry | Longer follow-ups on thrash |
| autopilot | `intelligence.autopilot` | on | Runtime decides ordered next steps | Agent must follow AUTOPILOT block |
| lessons | `intelligence.lessons.*` | off | Durable ranked lessons + decay | Uses context; enable when you want cross-session memory of gate fails |
| budget continue | `intelligence.budgetContinue` | off | Keep working under pressure if unfinished | Can delay clean stops |
| observability | usually global | signal on | Measure/diagnose | Disk under `.tlc/harness/state/` |
| mcpPrime / bootstrapExtra | arrays | empty | Project rails at sessionStart | Context cost |

Stagnation fingerprinting is built into grind gate fails (no separate toggle).

## CLI flags

```bash
tlc harness init --dry-run
tlc harness init --write [--stdin-json] [--force]
tlc harness init --minimal
```

`--minimal` writes a config that decides nothing — `{"version": 1}` — plus whichever provider shims are
detected. Everything else is inherited: the shipped defaults, then this machine's own config. Naming a value the
tiers below already resolve to would stop it tracking them, so a machine-wide change would never reach the project
([/decisions/ad-101.md](/decisions/ad-101.md)).

The wizard's answers go in through `--stdin-json`, and the ones that restate the tiers below are dropped the same
way. Prefer the harness-init skill for full discovery.

**An existing config is never overwritten.** `--minimal` and `--write` keep it and say so; only `--stdin-json`
replaces it, because that is the operator supplying a policy. To start over, delete the file first.

## After write

```bash
tlc harness status
tlc harness doctor
```

Next agent turn should set `TLC_ACTIVE` via the global `sessionStart` hook. Use `tlc harness help` for
concepts.

## Slash / global commands

Keep provider-native slash commands (e.g. Cursor's `~/.cursor/commands/`) global. Init must not create
`<repo>/.cursor/commands/` or an equivalent project-local commands directory for harness toggles or help.
