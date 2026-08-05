---
title: "Documentation log"
description: "Chronological, ISO 8601 record of notable events in the multi-provider harness port, grouped by date."
tags: [log, history]
timestamp: "2026-07-30"
---

# Log

## 2026-07-27

- `AD-001` recorded: optional sticky parent-Fast deny for Task/subagent spawns
  ([/decisions/ad-001.md](/decisions/ad-001.md)).

## 2026-07-29

- Provider-neutral rename decided and executed: `tlc` CLI, `~/.tlc/harness/` runtime home,
  `.tlc/harness/config.json` project policy, repo is `github.com/felipfr/tlc-agent-harness`
  ([/decisions/ad-002.md](/decisions/ad-002.md), [/decisions/ad-003.md](/decisions/ad-003.md)).
- Ports-and-adapters architecture with a `src/contracts/` shared-vocabulary module, a `ProviderPort` per
  provider, and a declarative `ProviderCapabilities` descriptor for degradation
  ([/decisions/ad-004.md](/decisions/ad-004.md), [/decisions/ad-010.md](/decisions/ad-010.md)).
- Local test runner (`tlc harness test`) established as the per-task gate; the `ubuntu|macos|windows` CI
  matrix built but kept dormant (`workflow_dispatch` only) until 2026-08-01
  ([/decisions/ad-005.md](/decisions/ad-005.md)).
- Windows declared designed-for but unvalidated ([/decisions/ad-006.md](/decisions/ad-006.md)).
- `tools/check-boundaries.ts` vendor-identifier scan extended to cover `src/core/**/__test__/`
  ([/decisions/ad-007.md](/decisions/ad-007.md)).
- Biome and TypeScript joined the gate; `@types/node` pinned to `^24`
  ([/decisions/ad-008.md](/decisions/ad-008.md)).
- Event-kind union settled at 18 members and `askSupportedOn` changed from a boolean pair to a list of
  kinds; `EffortLevel` has five levels
  ([/decisions/ad-009.md](/decisions/ad-009.md)).
- Vendor-specific data (model catalogs, cost pool names, lessons rendering) relocated from `core/` to each
  provider ([/decisions/ad-011.md](/decisions/ad-011.md)).
- Bun-first hook runtime measured and adopted, with Node + `dist/` kept as the guaranteed fallback
  ([/decisions/ad-012.md](/decisions/ad-012.md)).
- Documentation bundle format adopted: OKF v0.1, this bundle
  ([/decisions/ad-013.md](/decisions/ad-013.md)).
- Claude Code adapter built; hook payload field paths pinned against the documented hooks reference
  ([/decisions/ad-014.md](/decisions/ad-014.md)).
- Wiring handler names standardized to the `src/entrypoints/<name>.ts` filenames
  ([/decisions/ad-015.md](/decisions/ad-015.md)).
- Entrypoints wired end to end; seven cross-cutting corrections found by connecting every layer at once,
  including the `subagentType`/`spawnSubagentType` field split and the restored `shell.end` audit signal
  ([/decisions/ad-016.md](/decisions/ad-016.md)).
- `docs/`, `README.md`, `CONTRIBUTING.md`, `package.json`, the harness-init skill, and
  `.github/workflows/ci.yml` rewritten for `tlc harness …` / `.tlc/harness/` and both providers; this OKF
  bundle assembled; `tools/check-docs-bundle.ts` added to `tlc harness test`.

## 2026-07-30

- Published at `github.com/felipfr/tlc-agent-harness`.
- Floor tier added: five rules that read no config
  ([/decisions/ad-016.md](/decisions/ad-016.md)).
- `classifyShell` moved onto the shared shell tokenizer.
- Comment gate judges comments as blocks; doc comments are judged by informativeness against the
  identifier they document; `#` applies only to languages that use it.
- CI matrix enabled on `push` and `pull_request` across `ubuntu|macos|windows`
  ([/decisions/ad-005.md](/decisions/ad-005.md)).
- `bin/tlc-build` no longer uses `mapfile`, for bash 3.2 support. `.gitattributes` pins LF on checkout.
- Shell tokenizer preserves Windows path separators.
- Windows scope stated as CI coverage plus the two areas outside it
  ([/decisions/ad-006.md](/decisions/ad-006.md)).
- Optional docs staleness gate: runs the repository's own tool through the grind path, `warn` by default.
  Path mapping was measured reporting on 82–100% of commits and removed
  ([/decisions/ad-017.md](/decisions/ad-017.md)).
- Capability catalog became the only source for the wizard menu and the architecture rails table, generated
  and verified by `tools/render-capabilities.ts --check`.
- A warn-level lint diagnostic fails the gate (`biome check --error-on-warnings`), and `tools/check-suppressions.ts`
  fails it on a suppression whose reason is not a reason. Group-level `error` severity was measured at 3763
  findings — it enables each group's non-recommended rules, including the two that forbid the core facade — and
  rejected ([/decisions/ad-051.md](/decisions/ad-051.md)).
- Moved to `github.com/tech-leads-club/harness-toolkit` and renamed `harness-toolkit`. The CLI, `~/.tlc/harness`
  and `.tlc/harness/config.json` are unchanged, so no existing install re-initialises — TLC is Tech Leads Club,
  which makes the prefix more accurate under the org, not less ([/decisions/ad-052.md](/decisions/ad-052.md)).
