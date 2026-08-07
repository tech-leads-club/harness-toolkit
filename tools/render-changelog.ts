import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDecision } from "../src/core/release/release.decisions.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CHANGELOG_FILE = "CHANGELOG.md";

export const HEADER = [
  "# Changelog",
  "",
  "Generated from `docs/decisions/` — do not edit by hand. Run `node tools/render-changelog.ts`.",
  "",
  "Each entry is an architectural decision record: what changed, why, what was refused, and what it costs.",
  "A **Needs your action** line is a change `tlc harness doctor` cannot detect for you; everything else",
  "doctor reports against your own configuration.",
  "",
  "",
].join("\n");

/** why: the frontmatter title already opens with the id, and `**AD-001** — AD-001 — …` is what naive joining gives. */
export function withoutLeadingId(id: string, title: string): string {
  const prefix = new RegExp(`^${id}\\s*[—-]\\s*`, "i");
  return title.replace(prefix, "");
}

export type ReleasedDecisions = { version: string; decisions: string[] };

function git(args: string[], root: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/**
 * why: which release a decision landed in is already recorded — in git, as the tag containing the commit that
 * added the file. Writing it into the record too would be the second index AD-031 refused, and a second index
 * is a thing that can disagree with the first ([/decisions/ad-055.md](/decisions/ad-055.md)).
 */
export function decisionFilesInRange(root: string, range: string): string[] {
  const out = git(
    ["log", "--diff-filter=A", "--name-only", "--format=", range, "--", "docs/decisions"],
    root,
  );
  const files = out
    .split("\n")
    .map((line) => line.trim().replace(/^docs\/decisions\//, ""))
    .filter((file) => /^ad-\d+\.md$/.test(file));
  return [...new Set(files)].sort();
}

/** Tags oldest first. A repository with no tags has released nothing, which is a valid state, not an error. */
export function releaseTags(root: string): string[] {
  const out = git(["tag", "--list", "v*", "--sort=v:refname"], root);
  return out === "" ? [] : out.split("\n").map((tag) => tag.trim());
}

/**
 * why: the release PR bumps the version before the tag exists, so the section that will become `v1.2.0` is still
 * `Unreleased` when the PR is built. Naming the pending version here makes the PR carry the final document, and
 * regenerating after the tag lands produces byte-identical output — the same decisions, now inside the tag's
 * range. Without it the first push after every release would fail its own `--check`.
 */
export function collectReleases(root: string, pending?: string): ReleasedDecisions[] {
  const tags = releaseTags(root);
  const releases: ReleasedDecisions[] = [];
  let previous: string | null = null;
  for (const tag of tags) {
    releases.push({
      version: tag,
      decisions: decisionFilesInRange(root, previous === null ? tag : `${previous}..${tag}`),
    });
    previous = tag;
  }
  const head = previous === null ? "HEAD" : `${previous}..HEAD`;
  const unreleased = decisionFilesInRange(root, head);
  if (unreleased.length > 0 || pending !== undefined) {
    releases.push({ version: pending ?? "Unreleased", decisions: unreleased });
  }
  return releases.reverse();
}

export function pendingVersionArg(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("--release");
  if (at === -1) {
    return undefined;
  }
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--release needs a version, e.g. --release v1.2.0");
  }
  return value.startsWith("v") ? value : `v${value}`;
}

export function renderChangelog(root: string, releases: readonly ReleasedDecisions[]): string {
  const sections = releases.map((release) => {
    const lines = [`## ${release.version}`, ""];
    const summaries = release.decisions
      .map((file) => readDecision(root, file))
      .filter((decision) => decision !== null);
    if (summaries.length === 0) {
      lines.push("No decision records landed in this release.", "");
      return lines.join("\n");
    }
    for (const decision of summaries) {
      lines.push(`- **${decision.id}** — ${withoutLeadingId(decision.id, decision.title)}`);
      if (decision.migration !== undefined) {
        lines.push(`  - **Needs your action:** ${decision.migration}`);
      }
    }
    lines.push("");
    return lines.join("\n");
  });
  return `${HEADER}${sections.join("\n")}`;
}

export function currentChangelog(root: string): string {
  try {
    return readFileSync(join(root, CHANGELOG_FILE), "utf8");
  } catch {
    return "";
  }
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const pending = pendingVersionArg(process.argv);
  const next = renderChangelog(repoRoot, collectReleases(repoRoot, pending));
  const current = currentChangelog(repoRoot);

  if (next === current) {
    console.log("render-changelog: CHANGELOG.md matches docs/decisions/");
    process.exit(0);
  }
  if (check) {
    console.error("render-changelog: CHANGELOG.md is out of date — run: node tools/render-changelog.ts");
    process.exit(1);
  }
  writeFileSync(join(repoRoot, CHANGELOG_FILE), next, "utf8");
  console.log("render-changelog: CHANGELOG.md rewritten");
}
