---
type: Concept
title: "What this covers, and what it does not"
description: "A self-assessment of the harness against a published agentic-risk taxonomy: which of its own rules answer each risk, and what each one still leaves open. Control names are generated from the catalogs and checked by the gate."
tags: [coverage, security, self-assessment]
timestamp: "2026-08-17"
---

# What this covers, and what it does not

**This is a self-assessment, not an audit.** Nobody external has verified it. It is published because a list with
its gaps in it is more useful than a badge, and because this project refuses claims without evidence in the code
it governs — the same standard applies to its own README ([/decisions/ad-079.md](/decisions/ad-079.md)).

Taxonomy: OWASP Top 10 for Agentic Applications, 2026 list (ASI01–ASI10). A revision to that list makes this page stale and nothing here will notice; the
date above is how you tell.

**4 covered · 5 partial · 1 not applicable.**

Every name in the **Controls** column is a floor rule or a capability id, generated from
`src/core/floor/floor.catalog.ts` and `capabilities/catalog.json` and checked by the gate. A control that is
renamed or removed fails the build rather than leaving a claim standing here. The **What it leaves open** column is
judgement and is written by hand.

| Risk | State | Controls | What it leaves open |
|---|---|---|---|
| **ASI01** Agent goal hijack | partial | `untrustedContent`, `unprovable-execution`, `secret-access` | a command rewritten before it runs is not traced to the content it came from, and only shell actions are checked. The damaging tail is refused by the floor whoever suggested it |
| **ASI02** Tool misuse and exploitation | covered | `outside-project-destruction`, `unprovable-destruction`, `unprovable-execution`, `machine-control`, `catastrophicShell`, `shellStall` | — |
| **ASI03** Identity and privilege abuse | partial | `subagents`, `blockParentFast`, `policy-surface-write` | the substrate is one developer's editor session, so identity is the session. There is no per-agent credential to bind a decision to |
| **ASI04** Agentic supply chain | partial | `supplyChain` | a manifest changed without its lockfile, and a version nobody pinned. Advisories, licences and typosquats need the network on every stop and are left to a gate command |
| **ASI05** Unexpected code execution | covered | `unprovable-execution`, `unprovable-destruction`, `policy-surface-write` | — |
| **ASI06** Memory and context poisoning | partial | `policy-surface-write`, `lessons` | the handoff and the project lesson store are sealed on write and withheld when a write the harness did not make is detected. The global lesson store is written by other repositories' sessions and cannot be sealed per project |
| **ASI07** Insecure inter-agent communication | n/a | `subagents` | subagents are spawned by the host and exchange no messages the harness sits between. There is no wire to secure; what is governed is the spawn |
| **ASI08** Cascading agent failures | covered | `budgetContinue`, `shellStall`, `idleTurnGate`, `failureClassification`, `grind` | — |
| **ASI09** Human-agent trust exploitation | covered | `shipGate`, `emptyDiffAntiShip`, `planGate`, `comments` | — |
| **ASI10** Rogue agents | partial | `observe`, `subagents`, `idleTurnGate` | every decision is recorded and hash-chained, and a stalled or idle agent is caught. There is no behavioural baseline, so an agent acting plausibly but wrongly is not flagged |

## How to read "covered"

It means every mechanism this project has for that risk is in place and enforced before any policy is read, or is
a rail an operator can switch on. It does not mean the risk is eliminated. Prompt-level safety is a request to a
stochastic system, so what is claimed here is only ever about what happens in deterministic code *after* the model
decides ([/decisions/ad-016.md](/decisions/ad-016.md)).

## How to read "partial"

The row's limit says what is missing, in the terms an operator would notice. Three of the four partials are
partial for the same reason: the harness sits at one developer's editor, so it sees actions rather than identities,
and it sees what a turn wrote rather than what a turn meant.

## See also

- [/concepts.md](/concepts.md) — every rail from the operator's side
- [/troubleshooting.md](/troubleshooting.md) — from a refusal on screen back to the rule
- [/decisions/index.md](/decisions/index.md) — why each rule exists
