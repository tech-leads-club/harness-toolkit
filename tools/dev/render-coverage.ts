import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLOOR_RULES } from "../../src/core/floor/floor.catalog.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const COVERAGE_FILE = join("docs", "coverage.md");

/**
 * The risk taxonomy this repository assesses itself against, and which of its own controls answer each entry.
 *
 * hazard: the control column names floor rules and capability ids, so it is generated from the catalogs. Every
 * hand-written list of this project's own rules has drifted — the wizard's narrated half, the grind-lock timing in
 * `concepts.md`, and `secret-access`'s own description all did, inside one week
 * ([/decisions/ad-079.md](/decisions/ad-079.md)).
 *
 * invariant: `state` is judgement and is written by hand. `controls` is checked against what exists, so a rail
 * renamed or removed fails the gate rather than leaving a claim standing.
 */
export type CoverageRow = {
  id: string;
  risk: string;
  state: "covered" | "partial" | "not applicable";
  /** Floor rule names and capability ids. Verified to exist. */
  controls: string[];
  /** What is not covered, in the operator's terms. Required unless the state is `covered`. */
  limit?: string;
};

export const TAXONOMY_VERSION = "OWASP Top 10 for Agentic Applications, 2026 list (ASI01–ASI10)";

export const COVERAGE: readonly CoverageRow[] = [
  {
    id: "ASI01",
    risk: "Agent goal hijack",
    state: "partial",
    controls: ["untrustedContent", "unprovable-execution", "secret-access"],
    limit:
      "a command rewritten before it runs is not traced to the content it came from, and only shell actions are checked. The damaging tail is refused by the floor whoever suggested it",
  },
  {
    id: "ASI02",
    risk: "Tool misuse and exploitation",
    state: "covered",
    controls: [
      "outside-project-destruction",
      "unprovable-destruction",
      "unprovable-execution",
      "machine-control",
      "catastrophicShell",
      "shellStall",
    ],
  },
  {
    id: "ASI03",
    risk: "Identity and privilege abuse",
    state: "partial",
    controls: ["subagents", "blockParentFast", "policy-surface-write"],
    limit:
      "the substrate is one developer's editor session, so identity is the session. There is no per-agent credential to bind a decision to",
  },
  {
    id: "ASI04",
    risk: "Agentic supply chain",
    state: "partial",
    controls: ["supplyChain"],
    limit:
      "a manifest changed without its lockfile, and a version nobody pinned. Advisories, licences and typosquats need the network on every stop and are left to a gate command",
  },
  {
    id: "ASI05",
    risk: "Unexpected code execution",
    state: "covered",
    controls: ["unprovable-execution", "unprovable-destruction", "policy-surface-write"],
  },
  {
    id: "ASI06",
    risk: "Memory and context poisoning",
    state: "partial",
    controls: ["policy-surface-write", "lessons"],
    limit:
      "the handoff and the project lesson store are sealed on write and withheld when a write the harness did not make is detected. The global lesson store is written by other repositories' sessions and cannot be sealed per project",
  },
  {
    id: "ASI07",
    risk: "Insecure inter-agent communication",
    state: "not applicable",
    controls: ["subagents"],
    limit:
      "subagents are spawned by the host and exchange no messages the harness sits between. There is no wire to secure; what is governed is the spawn",
  },
  {
    id: "ASI08",
    risk: "Cascading agent failures",
    state: "covered",
    controls: ["budgetContinue", "shellStall", "idleTurnGate", "failureClassification", "grind"],
  },
  {
    id: "ASI09",
    risk: "Human-agent trust exploitation",
    state: "covered",
    controls: ["shipGate", "emptyDiffAntiShip", "planGate", "comments"],
  },
  {
    id: "ASI10",
    risk: "Rogue agents",
    state: "partial",
    controls: ["observe", "subagents", "idleTurnGate"],
    limit:
      "every decision is recorded and hash-chained, and a stalled or idle agent is caught. There is no behavioural baseline, so an agent acting plausibly but wrongly is not flagged",
  },
];

export type Violation = { rule: string; detail: string };

export function knownControls(root: string): Set<string> {
  const catalog = JSON.parse(readFileSync(join(root, "capabilities", "catalog.json"), "utf8")) as {
    capabilities: { id: string }[];
  };
  return new Set([...Object.keys(FLOOR_RULES), ...catalog.capabilities.map((capability) => capability.id)]);
}

export function checkCoverage(root: string, rows: readonly CoverageRow[] = COVERAGE): Violation[] {
  const known = knownControls(root);
  const violations: Violation[] = [];
  for (const row of rows) {
    for (const control of row.controls) {
      if (!known.has(control)) {
        violations.push({
          rule: "unknown-control",
          detail: `${row.id} claims \`${control}\`, which is neither a floor rule nor a capability id`,
        });
      }
    }
    // invariant: a state short of covered has to say what is missing, or the table becomes a claim with no edge.
    if (row.state !== "covered" && (row.limit === undefined || row.limit.length < 20)) {
      violations.push({ rule: "limit-missing", detail: `${row.id} is ${row.state} and states no limit` });
    }
    if (row.controls.length === 0) {
      violations.push({ rule: "no-controls", detail: `${row.id} names no control` });
    }
  }
  return violations;
}

const STATE_MARK: Record<CoverageRow["state"], string> = {
  covered: "covered",
  partial: "partial",
  "not applicable": "n/a",
};

export function renderCoverage(rows: readonly CoverageRow[] = COVERAGE): string {
  const counts = {
    covered: rows.filter((row) => row.state === "covered").length,
    partial: rows.filter((row) => row.state === "partial").length,
    na: rows.filter((row) => row.state === "not applicable").length,
  };
  return `---
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

Taxonomy: ${TAXONOMY_VERSION}. A revision to that list makes this page stale and nothing here will notice; the
date above is how you tell.

**${counts.covered} covered · ${counts.partial} partial · ${counts.na} not applicable.**

Every name in the **Controls** column is a floor rule or a capability id, generated from
\`src/core/floor/floor.catalog.ts\` and \`capabilities/catalog.json\` and checked by the gate. A control that is
renamed or removed fails the build rather than leaving a claim standing here. The **What it leaves open** column is
judgement and is written by hand.

| Risk | State | Controls | What it leaves open |
|---|---|---|---|
${rows
  .map(
    (row) =>
      `| **${row.id}** ${row.risk} | ${STATE_MARK[row.state]} | ${row.controls
        .map((control) => `\`${control}\``)
        .join(", ")} | ${row.limit ?? "—"} |`,
  )
  .join("\n")}

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
`;
}

if (import.meta.main) {
  const violations = checkCoverage(repoRoot);
  if (violations.length > 0) {
    console.error(`render-coverage: ${violations.length} violation(s)`);
    for (const violation of violations) {
      console.error(`  [${violation.rule}]  ${violation.detail}`);
    }
    process.exit(1);
  }
  const rendered = renderCoverage();
  const path = join(repoRoot, COVERAGE_FILE);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current === rendered) {
      console.log("render-coverage: docs/coverage.md matches the catalogs");
      process.exit(0);
    }
    console.error(
      "render-coverage: docs/coverage.md is out of date — run: node tools/dev/render-coverage.ts",
    );
    process.exit(1);
  }
  writeFileSync(path, rendered, "utf8");
  console.log(`render-coverage: docs/coverage.md rewritten (${COVERAGE.length} rows)`);
}
