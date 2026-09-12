import { execFileSync } from "node:child_process";

/**
 * why a ceiling and not a pass/fail: `noExcessiveCognitiveComplexity` runs at `info` in `biome.json` so the
 * standing count never blocks `biome check` ([/decisions/ad-139.md](/decisions/ad-139.md)) — the same shape
 * as `KNIP_EXPORTS_CEILING` in `bin/tlc-cli.ts` ([/decisions/ad-102.md](/decisions/ad-102.md)). Lowering it is
 * the point; raising it needs an argument in the diff.
 */
export const COMPLEXITY_CEILING = 42;

const COMPLEXITY_CATEGORY = "lint/complexity/noExcessiveCognitiveComplexity";

export type BiomeDiagnostic = {
  category?: string;
  message?: string;
  location?: { path?: string; start?: { line?: number } };
};

export type BiomeReport = { diagnostics?: BiomeDiagnostic[] };

export function complexityViolations(report: BiomeReport): BiomeDiagnostic[] {
  return (report.diagnostics ?? []).filter((diagnostic) => diagnostic.category === COMPLEXITY_CATEGORY);
}

// why: biome exits non-zero whenever any diagnostic exists, not only when this rule's own count grows past
// the ceiling below — its JSON report is still written to stdout on that exit, so the count is read from
// there. `--max-diagnostics=none` guards the same call: biome documents its printed-diagnostics cap for the
// text reporter, not `--reporter=json`, and this script should not depend on that staying true.
export function runBiomeReport(cwd: string): BiomeReport {
  try {
    const output = execFileSync("npx", ["biome", "check", "--reporter=json", "--max-diagnostics=none", "."], {
      cwd,
      encoding: "utf8",
    });
    return JSON.parse(output);
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.length > 0) {
      return JSON.parse(stdout);
    }
    throw error;
  }
}

export function formatReport(violations: readonly BiomeDiagnostic[], ceiling: number): string {
  if (violations.length <= ceiling) {
    return `check-complexity: ok (${violations.length}/${ceiling})`;
  }
  const lines = violations.map(
    (v) => `  ${v.location?.path ?? "?"}:${v.location?.start?.line ?? "?"}  ${v.message ?? ""}`,
  );
  return [`check-complexity: ${violations.length} violation(s), ceiling is ${ceiling}`, ...lines].join("\n");
}

function main(): void {
  const report = runBiomeReport(process.cwd());
  const violations = complexityViolations(report);
  console.log(formatReport(violations, COMPLEXITY_CEILING));
  if (violations.length > COMPLEXITY_CEILING) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
