import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Violation = { rule: string; file: string; detail: string };

/**
 * The shape every decision record carries.
 *
 * why: `## Decision` says what changed, `## Why` says what it cost to learn, `## Trade-offs` says what it cost to
 * choose, and `## Not decided here` says what a reader must not assume was settled. The last two are the ones a
 * record omits under time pressure, and they are the two that stop the same argument being had twice
 * ([/decisions/ad-069.md](/decisions/ad-069.md)).
 */
export const REQUIRED_HEADINGS = ["## Decision", "## Why", "## Trade-offs", "## Not decided here"] as const;

/**
 * invariant: `## Why` matches by prefix, so `## Why the runtime home had to change` satisfies it. A rule that
 * demanded the bare word would force worse prose than the records already have.
 */
function hasHeading(body: string, heading: string): boolean {
  const pattern = heading === "## Why" ? /^## Why/m : new RegExp(`^${heading}$`, "m");
  return pattern.test(body);
}

/**
 * A ratchet, not a wall.
 *
 * why: AD-021 onwards conform without exception; AD-001 through AD-020 predate the shape and use `## Applies to`
 * and `## Consequences` instead. Backfilling twenty sets of trade-offs would mean inventing them, and an
 * allow-list of the twenty would hide the twenty-first. The count may only fall, which is the rule
 * `tools/dev/check-screens.ts` already applies to screens.
 */
export const LEGACY_SHAPE_BUDGET = 20;

export const STATUSES = ["active", "archived"] as const;
export type DecisionStatus = (typeof STATUSES)[number];

export type DecisionFile = { file: string; body: string };

export function decisionFiles(root: string): DecisionFile[] {
  const out: DecisionFile[] = [];
  for (const dir of ["docs/decisions", "docs/decisions/archived"]) {
    const full = join(root, dir);
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(full, entry);
      if (!/^ad-\d+\.md$/.test(entry) || statSync(path).isDirectory()) {
        continue;
      }
      out.push({ file: relative(root, path), body: readFileSync(path, "utf8") });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export function statusOf(body: string): string | null {
  return /^- \*\*status\*\*:\s*(\S+)/m.exec(body)?.[1] ?? null;
}

export type DecisionOutcome = { violations: Violation[]; legacy: string[] };

export function checkDecisions(files: readonly DecisionFile[]): DecisionOutcome {
  const violations: Violation[] = [];
  const legacy: string[] = [];

  for (const { file, body } of files) {
    const status = statusOf(body);
    if (status === null) {
      violations.push({ rule: "status-missing", file, detail: "no `- **status**:` line" });
    } else if (!(STATUSES as readonly string[]).includes(status)) {
      violations.push({
        rule: "status-unknown",
        file,
        detail: `status \`${status}\` is not one of: ${STATUSES.join(", ")}`,
      });
    }

    // invariant: the folder and the status are one fact, so a record cannot sit in archived/ while claiming to
    // describe what currently binds.
    const archivedDir = file.includes("decisions/archived/");
    if (archivedDir && status !== "archived") {
      violations.push({ rule: "status-folder-mismatch", file, detail: "under archived/ but not `archived`" });
    }
    if (!archivedDir && status === "archived") {
      violations.push({
        rule: "status-folder-mismatch",
        file,
        detail: "status `archived` but still in docs/decisions/",
      });
    }

    const missing = REQUIRED_HEADINGS.filter((heading) => !hasHeading(body, heading));
    if (missing.length > 0) {
      legacy.push(`${file} (${missing.join(", ")})`);
    }
  }

  if (legacy.length > LEGACY_SHAPE_BUDGET) {
    violations.push({
      rule: "skeleton",
      file: legacy[LEGACY_SHAPE_BUDGET] ?? "",
      detail: `${legacy.length} record(s) off the current shape, budget is ${LEGACY_SHAPE_BUDGET}. Every record needs ${REQUIRED_HEADINGS.join(", ")}`,
    });
  }
  if (legacy.length < LEGACY_SHAPE_BUDGET) {
    // why: a ratchet that only ever refuses to rise is a ratchet nobody turns. Failing on a *lower* count is what
    // makes migrating one record a two-line change instead of a silent improvement nothing records.
    violations.push({
      rule: "skeleton-budget-stale",
      file: "tools/dev/check-decisions.ts",
      detail: `only ${legacy.length} record(s) are off the shape — lower LEGACY_SHAPE_BUDGET to ${legacy.length}`,
    });
  }
  return { violations, legacy };
}

const CITATION_DIRS = ["src", "tools", "bin", "docs"] as const;
const BARE_CITATION = /\(AD-(\d{3})\)/g;

function listFiles(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") {
        out.push(...listFiles(full, extensions));
      }
      continue;
    }
    if (extensions.some((extension) => full.endsWith(extension))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * why: a bundle-relative link survives a file move and `check-docs-bundle` resolves it; a bare parenthesised id
 * can only be checked by a reader who already knows the number. The repository was at 355 links to 15 bare
 * citations when this was written — a convention held by habit, which is the state just before it stops being
 * held at all.
 *
 * invariant: no file is exempt, including this one. The rule's own examples are written so they do not match,
 * because an exemption list is the place a real violation goes to hide.
 */
export function bareCitations(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const dir of CITATION_DIRS) {
    for (const file of listFiles(join(root, dir), [".ts", ".md", ".mts", ".mjs"])) {
      const relativePath = relative(root, file);
      for (const match of readFileSync(file, "utf8").matchAll(BARE_CITATION)) {
        const id = match[1] as string;
        violations.push({
          rule: "bare-citation",
          file: relativePath,
          detail: `(AD-${id}) — cite it as ([/decisions/ad-${id}.md](/decisions/ad-${id}.md))`,
        });
      }
    }
  }
  return violations;
}

export function report(
  outcome: DecisionOutcome,
  citations: readonly Violation[],
): {
  text: string;
  ok: boolean;
} {
  const all = [...outcome.violations, ...citations];
  const lines = all.map((violation) => `  [${violation.rule}]  ${violation.file}: ${violation.detail}`);
  lines.unshift(
    all.length === 0
      ? `check-decisions: ${outcome.legacy.length} record(s) on the older shape, every citation is a link`
      : `check-decisions: ${all.length} violation(s)`,
  );
  return { text: lines.join("\n"), ok: all.length === 0 };
}

if (import.meta.main) {
  const printed = report(checkDecisions(decisionFiles(repoRoot)), bareCitations(repoRoot));
  console.log(printed.text);
  process.exit(printed.ok ? 0 : 1);
}
