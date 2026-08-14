import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allDecisionFiles,
  type DecisionSummary,
  readDecisions,
} from "../../src/core/release/release.decisions.ts";
import { withoutLeadingId } from "./render-changelog.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const LOG_FILE = join("docs", "log.md");

/**
 * why: `log.md` is a reserved file of the OKF v0.1 bundle this repository adopted
 * ([/decisions/ad-013.md](/decisions/ad-013.md)), so it cannot simply be retired. It was hand-maintained and had
 * drifted to 19 of 66 records. Rendering it from the same decision files the changelog reads keeps the format
 * satisfied without a second thing to remember ([/decisions/ad-067.md](/decisions/ad-067.md)).
 */
export const HEADER = [
  "---",
  "type: Aggregate",
  'title: "Documentation log"',
  'description: "Chronological, ISO 8601 record of every architectural decision, grouped by the date it was taken. Generated from docs/decisions/."',
  "tags: [log, history, okf]",
  'timestamp: "2026-08-12"',
  "---",
  "",
  "# Log",
  "",
  "Generated from `docs/decisions/` — do not edit by hand. Run `node tools/render-log.ts`.",
  "",
  "A reserved file of the [OKF v0.1](/decisions/ad-013.md) bundle: entries grouped under ISO 8601 headings,",
  "newest first. For what landed in which npm release, see `CHANGELOG.md` at the repository root.",
  "",
].join("\n");

export type DatedDecision = DecisionSummary & { timestamp: string };

/**
 * invariant: a record with no `timestamp` is dropped rather than filed under a guessed date. `check-docs-bundle`
 * requires the frontmatter field on every decision, so an absent one is a bundle violation the gate already
 * catches — inventing a date here would hide it.
 */
export function datedDecisions(root: string): DatedDecision[] {
  return readDecisions(root, allDecisionFiles(root))
    .filter((decision): decision is DatedDecision => typeof decision.timestamp === "string")
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
}

export function groupByDate(decisions: readonly DatedDecision[]): [string, DatedDecision[]][] {
  const byDate = new Map<string, DatedDecision[]>();
  for (const decision of decisions) {
    byDate.set(decision.timestamp, [...(byDate.get(decision.timestamp) ?? []), decision]);
  }
  return [...byDate.entries()];
}

export function renderLog(decisions: readonly DatedDecision[]): string {
  const sections = groupByDate(decisions).map(([date, entries]) => {
    const lines = [`## ${date}`, ""];
    // why: ascending within a day, because AD-064 was taken before AD-065 and reading them the other way round
    // inverts the reasoning. The days themselves stay newest-first.
    for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(
        `- **${entry.id}** — ${withoutLeadingId(entry.id, entry.title)} ([${entry.path}](${entry.path}))`,
      );
    }
    lines.push("");
    return lines.join("\n");
  });
  return `${HEADER}\n${sections.join("\n")}`;
}

export function currentLog(root: string): string {
  try {
    return readFileSync(join(root, LOG_FILE), "utf8");
  } catch {
    return "";
  }
}

if (import.meta.main) {
  const rendered = renderLog(datedDecisions(repoRoot));
  if (process.argv.includes("--check")) {
    if (currentLog(repoRoot) === rendered) {
      console.log("render-log: docs/log.md matches docs/decisions/");
      process.exit(0);
    }
    console.error("render-log: docs/log.md is out of date — run: node tools/render-log.ts");
    process.exit(1);
  }
  writeFileSync(join(repoRoot, LOG_FILE), rendered, "utf8");
  console.log(`render-log: docs/log.md rewritten (${datedDecisions(repoRoot).length} record(s))`);
}
