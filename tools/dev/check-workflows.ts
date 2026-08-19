import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const WORKFLOW_DIR = join(".github", "workflows");

export type Violation = { rule: string; file: string; line: number; detail: string };

/**
 * A third-party action referenced by tag is a dependency nobody pinned.
 *
 * why: this repository refuses exactly this in somebody else's manifest — `supplyChain` asks before a turn adds a
 * dependency without a version, on the grounds that what a tag resolves to is whatever the publisher last pushed
 * ([/decisions/ad-075.md](/decisions/ad-075.md)). Nine of twelve `uses:` here were tags while that rail shipped, so
 * the rule applied to users and not to us ([/decisions/ad-084.md](/decisions/ad-084.md)).
 *
 * invariant: a local workflow (`./.github/workflows/…`) is this repository at this commit and cannot be
 * substituted, so it is exempt — the thing a pin defends against does not exist for it.
 */
const USES = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/;
const SHA = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /#\s*v?\d+(\.\d+)*/;

export type UseSite = { file: string; line: number; ref: string; rest: string };

export function usesInWorkflow(file: string, body: string): UseSite[] {
  const out: UseSite[] = [];
  body.split("\n").forEach((text, index) => {
    const match = USES.exec(text);
    if (match?.[1] !== undefined) {
      out.push({ file, line: index + 1, ref: match[1], rest: match[2] ?? "" });
    }
  });
  return out;
}

export function workflowFiles(root: string): { file: string; body: string }[] {
  const dir = join(root, WORKFLOW_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .sort()
    .map((entry) => ({
      file: `${WORKFLOW_DIR.split("\\").join("/")}/${entry}`,
      body: readFileSync(join(dir, entry), "utf8"),
    }));
}

export function checkUses(sites: readonly UseSite[]): Violation[] {
  const violations: Violation[] = [];
  for (const site of sites) {
    if (site.ref.startsWith("./") || site.ref.startsWith("docker://")) {
      continue;
    }
    const [action, ref] = site.ref.split("@");
    if (ref === undefined) {
      violations.push({
        rule: "unpinned-action",
        file: site.file,
        line: site.line,
        detail: `\`${site.ref}\` names no ref at all`,
      });
      continue;
    }
    if (!SHA.test(ref)) {
      violations.push({
        rule: "unpinned-action",
        file: site.file,
        line: site.line,
        detail: `\`${action}@${ref}\` is a tag — pin the 40-character commit SHA and put the version in a comment`,
      });
      continue;
    }
    // why: a bare SHA is unreadable, so the version it stands for is required next to it. Without that, bumping an
    // action means resolving forty characters by hand to find out what you are on.
    if (!VERSION_COMMENT.test(site.rest)) {
      violations.push({
        rule: "pin-without-version",
        file: site.file,
        line: site.line,
        detail: `\`${action}\` is pinned to a SHA but does not say which version — add \`# vX.Y.Z\``,
      });
    }
  }
  return violations;
}

export function checkWorkflows(root: string): Violation[] {
  return workflowFiles(root).flatMap(({ file, body }) => checkUses(usesInWorkflow(file, body)));
}

export function report(violations: readonly Violation[], siteCount: number): { text: string; ok: boolean } {
  const lines = violations.map(
    (violation) => `  [${violation.rule}]  ${violation.file}:${violation.line}: ${violation.detail}`,
  );
  lines.unshift(
    violations.length === 0
      ? `check-workflows: ${siteCount} action reference(s), every third-party one pinned to a SHA`
      : `check-workflows: ${violations.length} violation(s)`,
  );
  return { text: lines.join("\n"), ok: violations.length === 0 };
}

if (import.meta.main) {
  const sites = workflowFiles(repoRoot).flatMap(({ file, body }) => usesInWorkflow(file, body));
  const printed = report(checkWorkflows(repoRoot), sites.length);
  console.log(printed.text);
  process.exit(printed.ok ? 0 : 1);
}
