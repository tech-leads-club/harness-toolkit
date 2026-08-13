import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// tools/render-log.ts
import { readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

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
  const timestamp = frontmatterField(text, "timestamp");
  return {
    id,
    title,
    ...migration === undefined ? {} : { migration },
    ...timestamp === undefined ? {} : { timestamp }
  };
}
function readDecisions(repoRoot, files) {
  return files.filter((file) => /^ad-\d+\.md$/.test(file)).map((file) => readDecision(repoRoot, file)).filter((decision) => decision !== null).sort((a, b) => a.id.localeCompare(b.id));
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
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
var repoRoot = join2(dirname(fileURLToPath(import.meta.url)), "..");
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
if (false) {}

// tools/render-log.ts
var repoRoot2 = join3(dirname2(fileURLToPath2(import.meta.url)), "..");
var LOG_FILE = join3("docs", "log.md");
var HEADER2 = [
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
  ""
].join(`
`);
function datedDecisions(root) {
  return readDecisions(root, allDecisionFiles(root)).filter((decision) => typeof decision.timestamp === "string").sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
}
function groupByDate(decisions) {
  const byDate = new Map;
  for (const decision of decisions) {
    byDate.set(decision.timestamp, [...byDate.get(decision.timestamp) ?? [], decision]);
  }
  return [...byDate.entries()];
}
function renderLog(decisions) {
  const sections = groupByDate(decisions).map(([date, entries]) => {
    const lines = [`## ${date}`, ""];
    for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
      const file = `${entry.id.toLowerCase()}.md`;
      lines.push(`- **${entry.id}** — ${withoutLeadingId(entry.id, entry.title)} ([/decisions/${file}](/decisions/${file}))`);
    }
    lines.push("");
    return lines.join(`
`);
  });
  return `${HEADER2}
${sections.join(`
`)}`;
}
function currentLog(root) {
  try {
    return readFileSync2(join3(root, LOG_FILE), "utf8");
  } catch {
    return "";
  }
}
if (__require.main == __require.module) {
  const rendered = renderLog(datedDecisions(repoRoot2));
  if (process.argv.includes("--check")) {
    if (currentLog(repoRoot2) === rendered) {
      console.log("render-log: docs/log.md matches docs/decisions/");
      process.exit(0);
    }
    console.error("render-log: docs/log.md is out of date — run: node tools/render-log.ts");
    process.exit(1);
  }
  writeFileSync(join3(repoRoot2, LOG_FILE), rendered, "utf8");
  console.log(`render-log: docs/log.md rewritten (${datedDecisions(repoRoot2).length} record(s))`);
}
export {
  renderLog,
  groupByDate,
  datedDecisions,
  currentLog,
  LOG_FILE,
  HEADER2 as HEADER
};
