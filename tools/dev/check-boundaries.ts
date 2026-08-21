import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { normalizeSeparators } from "../../src/platform/sanitize.ts";

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

/**
 * The one file allowed to write the home into the environment.
 *
 * why: the rule exists so production resolves the home with `os.homedir()`, which is the portable answer — on
 * Windows the variable is `USERPROFILE` ([/decisions/ad-006.md](/decisions/ad-006.md)). The test harness is the
 * opposite job: it *sets* the variable so `os.homedir()` answers a throwaway, which is what keeps a suite from
 * writing into the operator's real directories ([/decisions/ad-102.md](/decisions/ad-102.md)).
 *
 * invariant: exactly one entry, asserted by a test. A second exemption has to be argued for, not appended.
 */
export const HOME_ENV_EXEMPT = ["tools/test-env.mjs"] as const;
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

/**
 * A module may be imported, but only through its barrel.
 *
 * hazard: the direction checks above ban an import outright, so nothing covered "may import, but only the front
 * door". Four test files reached into `core/observability/…` and `providers/claude/…` for values the barrels did not
 * publish, which is the coupling a facade exists to prevent — and no check could see it
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * why the barrels were widened rather than the imports left alone: a caller reaching past the front door is usually
 * telling you the front door is missing something.
 */
function checkDeepImports(root: string, fromRel: string, intoRel: string, rule: string): Violation[] {
  const intoAbs = resolve(root, intoRel);
  const barrel = join(intoAbs, "index.ts");
  const violations: Violation[] = [];
  // why tests are included here and nowhere else: a test reaching past a barrel is the same coupling as production
  // reaching past it, and every one of the four this check was written for lived in a test file. The direction
  // checks above scan production only, which is why nothing could see them.
  for (const file of listSourceFiles(join(root, fromRel), true)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((lineText, idx) => {
        const importSpec = IMPORT_SPEC_PATTERN.exec(lineText)?.[1];
        if (importSpec === undefined || !importSpec.startsWith(".")) {
          return;
        }
        const resolvedSpec = resolve(dirname(file), importSpec);
        const inside = resolvedSpec === intoAbs || resolvedSpec.startsWith(`${intoAbs}${sep}`);
        if (inside && resolvedSpec !== barrel) {
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
        listSourceFiles(join(config.root, rel)).filter(
          /**
           * hazard: this compared `relative()` output with a `/`-spelled literal, and `relative()` answers
           * `tools\test-env.mjs` on Windows — so the exemption never matched there and the harness's own file was
           * reported as a violation. The gate failed on the Windows leg for a legitimate file, and only there
           * ([/decisions/ad-102.md](/decisions/ad-102.md)).
           */
          (file) =>
            !HOME_ENV_EXEMPT.some((exempt) => normalizeSeparators(relative(config.root, file)) === exempt),
        ),
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

  violations.push(
    ...checkDeepImports(config.root, config.entrypointsDir, config.coreDir, "entrypoints-deep-imports-core"),
  );
  violations.push(
    ...checkDeepImports(
      config.root,
      config.entrypointsDir,
      config.providersDir,
      "entrypoints-deep-imports-providers",
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
