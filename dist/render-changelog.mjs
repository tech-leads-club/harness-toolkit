import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// tools/render-changelog.ts
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/release/release.decisions.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
function frontmatterField(text, field) {
  const match = new RegExp(`^${field}:\\s*"?(.+?)"?\\s*$`, "m").exec(text);
  const value = match?.[1]?.trim();
  if (value === undefined || value === "") {
    return;
  }
  return value.replace(/\\(["'\\])/g, "$1");
}
function decisionsDir(repoRoot) {
  return join(repoRoot, "docs", "decisions");
}
function readDecision(repoRoot, file) {
  const path = join(decisionsDir(repoRoot), file);
  if (!existsSync(path)) {
    return null;
  }
  let text;
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
  return migration === undefined ? { id, title } : { id, title, migration };
}
function allDecisionFiles(repoRoot) {
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

// tools/render-changelog.ts
var repoRoot = join2(dirname(fileURLToPath(import.meta.url)), "..");
var CHANGELOG_FILE = "CHANGELOG.md";
var HEADER = [
  "# Changelog",
  "",
  "Generated from `docs/decisions/` — do not edit by hand. Run `node tools/render-changelog.ts`.",
  "",
  "Each entry is an architectural decision record: what changed, why, what was refused, and what it costs.",
  "A **Needs your action** line is a change `tlc harness doctor` cannot detect for you; everything else",
  "doctor reports against your own configuration.",
  "",
  ""
].join(`
`);
function withoutLeadingId(id, title) {
  const prefix = new RegExp(`^${id}\\s*[—-]\\s*`, "i");
  return title.replace(prefix, "");
}
function git(args, root) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function decisionFilesInRange(root, range) {
  const out = git(["log", "--diff-filter=A", "--name-only", "--format=", range, "--", "docs/decisions"], root);
  const files = out.split(`
`).map((line) => line.trim().replace(/^docs\/decisions\//, "")).filter((file) => /^ad-\d+\.md$/.test(file));
  return [...new Set(files)].sort();
}
function isShallow(root) {
  try {
    return git(["rev-parse", "--is-shallow-repository"], root) === "true";
  } catch {
    return false;
  }
}
function releaseTags(root) {
  const out = git(["tag", "--list", "v*", "--sort=v:refname"], root);
  return out === "" ? [] : out.split(`
`).map((tag) => tag.trim());
}
function collectReleases(root, pending) {
  const tags = releaseTags(root);
  const releases = [];
  let previous = null;
  for (const tag of tags) {
    releases.push({
      version: tag,
      decisions: decisionFilesInRange(root, previous === null ? tag : `${previous}..${tag}`)
    });
    previous = tag;
  }
  const released = new Set(releases.flatMap((release) => release.decisions));
  const unreleased = allDecisionFiles(root).filter((file) => !released.has(file)).sort();
  if (unreleased.length > 0 || pending !== undefined) {
    releases.push({ version: pending ?? "Unreleased", decisions: unreleased });
  }
  return releases.reverse();
}
function pendingVersionArg(argv) {
  const at = argv.indexOf("--release");
  if (at === -1) {
    return;
  }
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--release needs a version, e.g. --release v1.2.0");
  }
  return value.startsWith("v") ? value : `v${value}`;
}
function renderChangelog(root, releases) {
  const sections = releases.map((release) => {
    const lines = [`## ${release.version}`, ""];
    const summaries = release.decisions.map((file) => readDecision(root, file)).filter((decision) => decision !== null);
    if (summaries.length === 0) {
      lines.push("No decision records landed in this release.", "");
      return lines.join(`
`);
    }
    for (const decision of summaries) {
      lines.push(`- **${decision.id}** — ${withoutLeadingId(decision.id, decision.title)}`);
      if (decision.migration !== undefined) {
        lines.push(`  - **Needs your action:** ${decision.migration}`);
      }
    }
    lines.push("");
    return lines.join(`
`);
  });
  return `${HEADER}${sections.join(`
`)}`;
}
function packageVersionTag(root) {
  const pkg = JSON.parse(readFileSync2(join2(root, "package.json"), "utf8"));
  return `v${pkg.version ?? "0.0.0"}`;
}
function acceptableRenderings(root) {
  const plain = renderChangelog(root, collectReleases(root));
  const pending = packageVersionTag(root);
  if (releaseTags(root).includes(pending)) {
    return [plain];
  }
  return [plain, renderChangelog(root, collectReleases(root, pending))];
}
function currentChangelog(root) {
  try {
    return readFileSync2(join2(root, CHANGELOG_FILE), "utf8");
  } catch {
    return "";
  }
}
if (__require.main == __require.module) {
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
  writeFileSync(join2(repoRoot, CHANGELOG_FILE), next, "utf8");
  console.log("render-changelog: CHANGELOG.md rewritten");
}
export {
  withoutLeadingId,
  renderChangelog,
  releaseTags,
  pendingVersionArg,
  packageVersionTag,
  isShallow,
  decisionFilesInRange,
  currentChangelog,
  collectReleases,
  acceptableRenderings,
  HEADER,
  CHANGELOG_FILE
};
