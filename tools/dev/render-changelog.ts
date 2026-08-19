import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allDecisionFiles, readDecision } from "../../src/core/release/release.decisions.ts";
import { tagPrefixFor, versionInTag } from "../../src/core/release/release.version.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

/**
 * hazard: `actions/checkout` clones one commit deep by default, so `git log --diff-filter=A` reports that no
 * decision record was ever added and `git tag` reports no releases. The generator then produced an empty document
 * and `--check` failed on all three runners with "CHANGELOG.md is out of date" — a true statement about a
 * repository the checkout could not see. A check that cannot see its input reports that, rather than a verdict.
 */
export function isShallow(root: string): boolean {
  try {
    return git(["rev-parse", "--is-shallow-repository"], root) === "true";
  } catch {
    return false;
  }
}

/**
 * Tags oldest first. A repository with no tags has released nothing, which is a valid state, not an error.
 *
 * hazard: this listed `v*` while every tag this repository has ever created is `harness-toolkit-v…`. It matched
 * none, so all 88 decision records sat under `## Unreleased` across three published releases — and `--check`
 * passed the whole time, because the generated document and the committed one were wrong identically. The prefix is
 * now derived from the package name, which is the same source the tag is written from
 * ([/decisions/ad-088.md](/decisions/ad-088.md)).
 */
export function packageName(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
}

export function releaseTags(root: string): string[] {
  const name = packageName(root);
  // invariant: no manifest means no package name, and a release tag is named after the package — so there are no
  // releases to find. That is a different statement from the glob matching nothing, which was the defect.
  if (name === null) {
    return [];
  }
  const out = git(["tag", "--list", `${tagPrefixFor(name)}*`, "--sort=v:refname"], root);
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
  const name = packageName(root);
  for (const tag of tags) {
    releases.push({
      // why: the heading is the version a reader looks for, not the tag's package-prefixed spelling. The tag is
      // still what bounds the range, because it is what git resolves.
      version: `v${(name === null ? null : versionInTag(name, tag)) ?? tag}`,
      decisions: decisionFilesInRange(root, previous === null ? tag : `${previous}..${tag}`),
    });
    previous = tag;
  }
  // hazard: the unreleased bucket used `git log --diff-filter=A` too, which only sees committed adds — so the
  // commit that introduces a decision record could never contain the changelog entry for it, and the gate failed
  // on every such commit until a second one regenerated. Reading the directory instead makes a record count from
  // the moment it exists on disk, which is what the gate is asking about.
  const released = new Set(releases.flatMap((release) => release.decisions));
  const unreleased = allDecisionFiles(root)
    .filter((file) => !released.has(file))
    .sort();
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

/** The heading the pending section carries: the version a reader looks for. */
export function packageVersionLabel(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  return `v${pkg.version ?? "0.0.0"}`;
}

/**
 * The tag that version will get, which is what `releaseTags` can be compared against.
 *
 * hazard: this used to return the label — `v0.2.0` — and `acceptableRenderings` compared it against a tag list
 * spelled `harness-toolkit-v0.2.0`. The comparison was therefore never true, so the one-state tolerance it guards
 * never closed and `--check` permanently accepted two renderings, one of which is the stale one it exists to
 * refuse. The same mismatch as the tag glob, in the same file, hidden the same way
 * ([/decisions/ad-088.md](/decisions/ad-088.md)).
 */
export function packageVersionTag(root: string): string {
  const name = packageName(root);
  const label = packageVersionLabel(root);
  return name === null ? label : `${tagPrefixFor(name)}${label.slice(1)}`;
}

/**
 * hazard: `ci.yml` and `release.yml` both fire on a push to `main` and run in parallel, so on the commit that
 * merges a release PR the gate reads a CHANGELOG.md naming `v0.2.0` while the tag is still being created in the
 * other workflow. A plain comparison fails there, on every release, for a file that is already correct.
 *
 * invariant: the tolerance is exactly one state and it closes on its own. The pending rendering is accepted only
 * while no tag of that name exists; the moment `release-please` creates it, the tag range produces the same
 * document and only the plain rendering matches. It cannot be used to hold a stale file.
 */
export function acceptableRenderings(root: string): string[] {
  const plain = renderChangelog(root, collectReleases(root));
  // invariant: the tag is what closes the tolerance and the label is what the heading says. Comparing one against
  // the other is what kept it open for ever.
  if (releaseTags(root).includes(packageVersionTag(root))) {
    return [plain];
  }
  return [plain, renderChangelog(root, collectReleases(root, packageVersionLabel(root)))];
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
  if (isShallow(repoRoot)) {
    console.log("render-changelog: shallow checkout — skipped (needs full history; set fetch-depth: 0)");
    process.exit(0);
  }
  const pending = pendingVersionArg(process.argv);
  const current = currentChangelog(repoRoot);

  if (check) {
    if (acceptableRenderings(repoRoot).includes(current)) {
      console.log("render-changelog: CHANGELOG.md matches docs/decisions/");
      process.exit(0);
    }
    console.error("render-changelog: CHANGELOG.md is out of date — run: node tools/render-changelog.ts");
    process.exit(1);
  }

  const next = renderChangelog(repoRoot, collectReleases(repoRoot, pending));
  if (next === current) {
    console.log("render-changelog: CHANGELOG.md matches docs/decisions/");
    process.exit(0);
  }
  writeFileSync(join(repoRoot, CHANGELOG_FILE), next, "utf8");
  console.log("render-changelog: CHANGELOG.md rewritten");
}
