---
okf_version: "0.1"
title: "agent-harness documentation bundle"
description: "OKF v0.1 documentation bundle for the tlc harness — architecture, concepts, runbooks, provider adapters, and the full architectural decision log."
tags: [index, okf]
timestamp: "2026-07-29"
---

# agent-harness docs

This is an [Open Knowledge Format v0.1](/decisions/ad-013.md) bundle: every non-reserved document below
carries YAML frontmatter with a `type` from the closed vocabulary `Concept | Runbook | Provider | Decision
| Capability | Aggregate`, plus `title`, `description`, `tags`, and `timestamp`. Cross-links are absolute
and bundle-relative (e.g. `/decisions/ad-010.md`), never relative.

See [/log.md](/log.md) for the chronological record of this bundle's own construction.

## Concepts

| Doc | Description |
| --- | --- |
| [/architecture.md](/architecture.md) | Ports-and-adapters shape of the harness: contracts, core, providers, entrypoints, and how the tlc CLI and runtime home fit together. |
| [/concepts.md](/concepts.md) | The operator-facing concepts behind the harness: grind, pause/resume, shipGate, subagent allowlist, comment policy, catastrophic shell, shell stall, the intelligence rails, observability planes, and cost estimates. |
| [/lessons.md](/lessons.md) | Durable, ranked lessons that keep the agent from repeating gate failures — three tiers, staleness against a named reference, a validity window, effectiveness measured after injection, lifecycle, config, ranking, and the per-provider rendered view. |

## Runbooks

| Doc | Description |
| --- | --- |
| [/init.md](/init.md) | What tlc harness init creates, what it deliberately does not do, and the mandatory harness-init wizard's capability menu — including the Bun-vs-Node hook runtime question. |
| [/troubleshooting.md](/troubleshooting.md) | How to tell a harness decision from model behaviour, in the moment and after the fact: the one command that answers it, what each rule name means, and the four symptoms that are not the harness at all. |
| [/diagnose.md](/diagnose.md) | Checklist for hooks not firing, Node vs Bun runtime confusion, stale runtime, subagent denials, cost showing null, and double hooks — for both Cursor and Claude Code. |
| [/measure.md](/measure.md) | How to read harness observability: status, live signal, raw signal, session reports, audit trail, price catalogs, and the on-disk project state files, all provider-tagged. |

## Providers

| Doc | Description |
| --- | --- |
| [/providers/index.md](/providers/index.md) | Index of the provider adapters — Cursor and Claude Code — and the port they both implement. |
| [/providers/cursor.md](/providers/cursor.md) | The Cursor adapter — capability descriptor, event mapping, and wiring target for Cursor's hooks.json. |
| [/providers/claude-code.md](/providers/claude-code.md) | The Claude Code adapter — capability descriptor, event mapping, and wiring target for the settings.json hooks block in Claude Code's resolved config directory. |

## Decisions

| Doc | Description |
| --- | --- |
| [/decisions/index.md](/decisions/index.md) | Index of every architectural decision (AD-001…AD-016) made while building the multi-provider harness. |

Each individual decision (`/decisions/ad-001.md` … `/decisions/ad-016.md`) is listed with its own
description in [/decisions/index.md](/decisions/index.md).
