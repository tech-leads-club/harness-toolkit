import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Violation = {
  file: string;
  rule: string;
  detail: string;
};

export type DocsBundleConfig = {
  root: string;
  docsDir: string;
};

export const DEFAULT_CONFIG: Omit<DocsBundleConfig, "root"> = {
  docsDir: "docs",
};

export const OKF_TYPES = new Set(["Concept", "Runbook", "Provider", "Decision", "Capability", "Aggregate"]);

const REQUIRED_FIELDS = ["title", "description", "tags", "timestamp"] as const;

const RESERVED_FILES = new Set(["index.md", "log.md"]);

export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export type ParseResult = { frontmatter: Frontmatter | null; error: string | null };

function extractFrontmatterBlock(content: string): string | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return null;
  }
  const firstBreak = content.indexOf("\n");
  const rest = content.slice(firstBreak + 1);
  const closingMatch = /^---\s*$/m.exec(rest);
  if (!closingMatch) {
    return null;
  }
  return rest.slice(0, closingMatch.index);
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseValue(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") {
      return [];
    }
    return inner.split(",").map((item) => stripQuotes(item));
  }
  return stripQuotes(trimmed);
}

export function parseFrontmatter(content: string): ParseResult {
  const block = extractFrontmatterBlock(content);
  if (block === null) {
    return { frontmatter: null, error: "missing --- frontmatter block" };
  }
  const frontmatter: Frontmatter = {};
  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) {
      return { frontmatter: null, error: `unparseable frontmatter line: "${line}"` };
    }
    const key = line.slice(0, idx).trim();
    if (key === "") {
      return { frontmatter: null, error: `frontmatter line has an empty key: "${line}"` };
    }
    frontmatter[key] = parseValue(line.slice(idx + 1));
  }
  return { frontmatter, error: null };
}

function isNonEmptyString(value: FrontmatterValue | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonEmptyField(value: FrontmatterValue | undefined): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return isNonEmptyString(value);
}

function listMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listMarkdownFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function relKey(docsRoot: string, file: string): string {
  return relative(docsRoot, file).split(sep).join("/");
}

function checkIndex(rootRelFile: string, frontmatter: Frontmatter, violations: Violation[]): void {
  const okfVersion = frontmatter.okf_version;
  if (!isNonEmptyString(okfVersion)) {
    violations.push({
      file: rootRelFile,
      rule: "index-missing-okf-version",
      detail: "docs/index.md frontmatter must set a non-empty okf_version",
    });
  }
}

function checkLog(rootRelFile: string, content: string, violations: Violation[]): void {
  const isoHeading = /^#{1,6}\s+\d{4}-\d{2}-\d{2}/m;
  if (!isoHeading.test(content)) {
    violations.push({
      file: rootRelFile,
      rule: "log-not-dated",
      detail: "docs/log.md must group entries under ISO 8601 (YYYY-MM-DD) headings",
    });
  }
}

function checkConceptDoc(rootRelFile: string, frontmatter: Frontmatter, violations: Violation[]): void {
  const type = frontmatter.type;
  if (!isNonEmptyString(type)) {
    violations.push({
      file: rootRelFile,
      rule: "missing-type",
      detail: "frontmatter.type is missing or empty",
    });
  } else if (!OKF_TYPES.has(type)) {
    violations.push({
      file: rootRelFile,
      rule: "invalid-type",
      detail: `frontmatter.type "${type}" is not in the closed OKF vocabulary`,
    });
  }
  // why: optional, because most decisions need no operator action and requiring the field would produce a wall of
  // "no migration needed". Validated when present, because a note that is present and empty is worse than absent —
  // the update path would announce a decision as needing action and then show nothing
  // ([/decisions/ad-031.md](/decisions/ad-031.md)).
  if ("migration" in frontmatter && !isNonEmptyString(frontmatter.migration)) {
    violations.push({
      file: rootRelFile,
      rule: "empty-migration",
      detail: "frontmatter.migration is present but empty — remove it, or say what the operator must do",
    });
  }
  for (const field of REQUIRED_FIELDS) {
    if (!isNonEmptyField(frontmatter[field])) {
      violations.push({
        file: rootRelFile,
        rule: "missing-field",
        detail: `frontmatter.${field} is missing or empty`,
      });
    }
  }
}

export function runBundleChecks(config: DocsBundleConfig): Violation[] {
  const violations: Violation[] = [];
  const docsRoot = join(config.root, config.docsDir);
  if (!existsSync(docsRoot) || !statSync(docsRoot).isDirectory()) {
    return violations;
  }

  for (const file of listMarkdownFiles(docsRoot)) {
    const rootRelFile = relative(config.root, file);
    const bundleRelFile = relKey(docsRoot, file);
    const content = readFileSync(file, "utf8");
    const { frontmatter, error } = parseFrontmatter(content);

    if (frontmatter === null) {
      violations.push({
        file: rootRelFile,
        rule: "frontmatter-parse",
        detail: error ?? "frontmatter did not parse",
      });
      continue;
    }

    const isReserved = RESERVED_FILES.has(bundleRelFile);
    if (isReserved) {
      if (bundleRelFile === "index.md") {
        checkIndex(rootRelFile, frontmatter, violations);
      } else {
        checkLog(rootRelFile, content, violations);
      }
      continue;
    }

    checkConceptDoc(rootRelFile, frontmatter, violations);
  }

  return violations;
}

function main(): void {
  const violations = runBundleChecks({ root: process.cwd(), ...DEFAULT_CONFIG });
  if (violations.length === 0) {
    console.log("check-docs-bundle: ok (0 violations)");
    return;
  }
  console.error(`check-docs-bundle: ${violations.length} violation(s) found`);
  for (const v of violations) {
    console.error(`  ${v.file}  [${v.rule}]  ${v.detail}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
