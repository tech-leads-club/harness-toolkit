import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * why: the substance of a changelog already exists in this repository as thirty decision records, each carrying why,
 * the trade-offs and what was refused. What was missing is the mapping from "I updated" to "these landed". Reading
 * the records is that mapping, and it needs no second index to maintain
 * ([/decisions/ad-031.md](/decisions/ad-031.md)).
 *
 * invariant: a `migration` note is what marks a decision as needing operator action. Anything finer would be the
 * harness guessing whether a given config is affected, and `doctor` already answers that precisely — the note says
 * what to do, the doctor says whether it applies to you.
 */
export type DecisionSummary = {
  id: string;
  title: string;
  /** Present only when the decision requires the operator to change something. */
  migration?: string;
  /** why: the OKF bundle's `log.md` groups by ISO date, and the record already carries the date it was taken. */
  timestamp?: string;
};

function frontmatterField(text: string, field: string): string | undefined {
  // why: line-scoped, matching how `check-docs-bundle` reads the same files. The values here are single-line
  // quoted strings by convention, and the bundle check is what enforces that.
  const match = new RegExp(`^${field}:\\s*"?(.+?)"?\\s*$`, "m").exec(text);
  const value = match?.[1]?.trim();
  if (value === undefined || value === "") {
    return undefined;
  }
  // hazard: an escaped quote inside the value survived the outer-quote strip and reached the operator as a literal
  // `\"` in their terminal. Seen in a real update run ([/decisions/ad-034.md](/decisions/ad-034.md)).
  return value.replace(/\\(["'\\])/g, "$1");
}

export function decisionsDir(repoRoot: string): string {
  return join(repoRoot, "docs", "decisions");
}

/** why: an absent docs directory is an empty list, not an error. A linked checkout may not carry docs at all. */
export function readDecision(repoRoot: string, file: string): DecisionSummary | null {
  const path = join(decisionsDir(repoRoot), file);
  if (!existsSync(path)) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const title = frontmatterField(text, "title");
  if (title === undefined) {
    return null;
  }
  const id = file.replace(/\.md$/, "").toUpperCase();
  const migration = frontmatterField(text, "migration");
  const timestamp = frontmatterField(text, "timestamp");
  return {
    id,
    title,
    ...(migration === undefined ? {} : { migration }),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

export function readDecisions(repoRoot: string, files: string[]): DecisionSummary[] {
  return files
    .filter((file) => /^ad-\d+\.md$/.test(file))
    .map((file) => readDecision(repoRoot, file))
    .filter((decision): decision is DecisionSummary => decision !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function allDecisionFiles(repoRoot: string): string[] {
  const dir = decisionsDir(repoRoot);
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir).filter((file) => /^ad-\d+\.md$/.test(file));
  } catch {
    return [];
  }
}

export function needsAction(decisions: readonly DecisionSummary[]): DecisionSummary[] {
  return decisions.filter((decision) => decision.migration !== undefined);
}

/** why: `AD-031 — Some title` → `AD-031`, so an id can trail a sentence instead of leading it. */
function idOf(decision: DecisionSummary): string {
  return decision.id;
}

/**
 * hazard: the first version led with each decision's *title*, which describes the author's reasoning rather than the
 * operator's situation, and printed `NEEDS YOUR ACTION` for every note. In a real update run both notes said "run
 * `tlc harness doctor`" — which `update` then did automatically, three lines below — and neither applied to that
 * project. An alarm that fires on every update is one the reader learns to scroll past, and the next one that matters
 * goes with it ([/decisions/ad-034.md](/decisions/ad-034.md)).
 *
 * invariant: the note is the headline and the decision id trails it. The heading appears only when a note exists, and
 * it says what a note now means: something `doctor` cannot detect for you.
 */
export function formatDecisionDigest(decisions: readonly DecisionSummary[]): string {
  if (decisions.length === 0) {
    return "";
  }
  const action = needsAction(decisions);
  const lines: string[] = [
    `Harness updated. ${decisions.length} decision(s) landed; doctor runs below and reports what applies here.`,
  ];
  if (action.length > 0) {
    lines.push("", `Needs a change doctor cannot detect for you (${action.length}):`);
    for (const decision of action) {
      lines.push(`  ${decision.migration}  (${idOf(decision)})`);
    }
  }
  const rest = decisions.filter((decision) => decision.migration === undefined);
  if (rest.length > 0) {
    lines.push("", `Also landed: ${rest.map(idOf).join(", ")} — docs/decisions/index.md`);
  } else {
    lines.push("", "Full reasoning: docs/decisions/index.md");
  }
  return lines.join("\n");
}
