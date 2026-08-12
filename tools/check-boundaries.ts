import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type Violation = {
  file: string;
  line: number;
  rule: string;
  detail: string;
};

export type BoundaryCheckConfig = {
  root: string;
  vendorScanRoots: string[];
  homeEnvScanRoots: string[];
  cursorPathScanRoots: string[];
  coreDir: string;
  providersDir: string;
  contractsDir: string;
  platformDir: string;
  entrypointsDir: string;
  /**
   * hazard: a colour escape reaching output a machine parses is a defect, not a cosmetic. One already matched the
   * path pattern in gate output and sent an agent to fix `39msrc/…`, a file that does not exist. These directories
   * answer the host and render `--json`, so they never style anything
   * ([/decisions/ad-063.md](/decisions/ad-063.md)).
   */
  noStyleDirs: string[];
  styleModule: string;
};

export const DEFAULT_CONFIG: Omit<BoundaryCheckConfig, "root"> = {
  vendorScanRoots: ["src/core", "src/contracts"],
  homeEnvScanRoots: ["src", "tools", "bin"],
  cursorPathScanRoots: ["src", "tools", "bin"],
  coreDir: "src/core",
  providersDir: "src/providers",
  contractsDir: "src/contracts",
  platformDir: "src/platform",
  entrypointsDir: "src/entrypoints",
  noStyleDirs: ["src/providers", "src/entrypoints"],
  styleModule: "src/platform/style.ts",
};

const VENDOR_PATTERN = /\b(cursor|claude|codex|composer|anthropic)\b/i;
const HOME_ENV_PATTERN = /process\.env\.HOME\b/;
const CURSOR_PATH_PATTERN = /\.cursor\/(harness|agent-harness)/;
const IMPORT_SPEC_PATTERN = /(?:from|import)\s+["']([^"']+)["']/;
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs)$/;

// why: __test__ is scanned for vendor identifiers but excluded from the other absence checks — a test asserting a string is absent must itself contain that string.
function listSourceFiles(path: string, includeTests = false): string[] {
  if (!existsSync(path)) {
    return [];
  }
  if (statSync(path).isFile()) {
    return SOURCE_EXTENSIONS.test(path) ? [path] : [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }
    if (entry.name === "__test__" && !includeTests) {
      continue;
    }
    results.push(...listSourceFiles(join(path, entry.name), includeTests));
  }
  return results;
}

function scanForPattern(files: string[], pattern: RegExp, rule: string, root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((lineText, idx) => {
      if (pattern.test(lineText)) {
        violations.push({ file: relative(root, file), line: idx + 1, rule, detail: lineText.trim() });
      }
    });
  }
  return violations;
}

function checkCrossImports(root: string, fromRel: string, forbiddenRel: string, rule: string): Violation[] {
  const forbiddenAbs = resolve(root, forbiddenRel);
  const violations: Violation[] = [];
  for (const file of listSourceFiles(join(root, fromRel))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((lineText, idx) => {
      const match = IMPORT_SPEC_PATTERN.exec(lineText);
      const importSpec = match?.[1];
      if (importSpec === undefined || !importSpec.startsWith(".")) {
        return;
      }
      const resolvedSpec = resolve(dirname(file), importSpec);
      if (resolvedSpec === forbiddenAbs || resolvedSpec.startsWith(`${forbiddenAbs}${sep}`)) {
        violations.push({ file: relative(root, file), line: idx + 1, rule, detail: lineText.trim() });
      }
    });
  }
  return violations;
}

export function runBoundaryChecks(config: BoundaryCheckConfig): Violation[] {
  const violations: Violation[] = [];

  for (const rel of config.vendorScanRoots) {
    violations.push(
      ...scanForPattern(
        listSourceFiles(join(config.root, rel), true),
        VENDOR_PATTERN,
        "vendor-identifier-in-core",
        config.root,
      ),
    );
  }
  for (const rel of config.homeEnvScanRoots) {
    violations.push(
      ...scanForPattern(
        listSourceFiles(join(config.root, rel)),
        HOME_ENV_PATTERN,
        "process-env-home",
        config.root,
      ),
    );
  }
  for (const rel of config.cursorPathScanRoots) {
    violations.push(
      ...scanForPattern(
        listSourceFiles(join(config.root, rel)),
        CURSOR_PATH_PATTERN,
        "cursor-legacy-path",
        config.root,
      ),
    );
  }
  for (const rel of config.noStyleDirs) {
    violations.push(
      ...checkCrossImports(config.root, rel, config.styleModule, "styles-machine-readable-output"),
    );
  }
  violations.push(
    ...checkCrossImports(config.root, config.coreDir, config.providersDir, "core-imports-providers"),
  );
  violations.push(
    ...checkCrossImports(config.root, config.providersDir, config.coreDir, "providers-imports-core"),
  );
  violations.push(
    ...checkCrossImports(config.root, config.contractsDir, config.coreDir, "contracts-imports-core"),
  );
  violations.push(
    ...checkCrossImports(
      config.root,
      config.contractsDir,
      config.providersDir,
      "contracts-imports-providers",
    ),
  );
  violations.push(
    ...checkCrossImports(config.root, config.contractsDir, config.platformDir, "contracts-imports-platform"),
  );
  violations.push(
    ...checkCrossImports(
      config.root,
      config.contractsDir,
      config.entrypointsDir,
      "contracts-imports-entrypoints",
    ),
  );

  return violations;
}

function main(): void {
  const violations = runBoundaryChecks({ root: process.cwd(), ...DEFAULT_CONFIG });
  if (violations.length === 0) {
    console.log("check-boundaries: ok (0 violations)");
    return;
  }
  console.error(`check-boundaries: ${violations.length} violation(s) found`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.detail}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
