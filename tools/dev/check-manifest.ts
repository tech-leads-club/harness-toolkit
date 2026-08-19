import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Violation = { rule: string; detail: string };

/**
 * The manifest npm publishes is not always the manifest we wrote.
 *
 * hazard: `bin` declared `./bin/tlc.mjs` and npm dropped both entries — `"bin[tlc]" script name bin/tlc.mjs was
 * invalid and removed` — so the published package would have installed no command at all. Measured in a fixture:
 * `./bin/x.mjs` removed, `bin/x.mjs` accepted. Nothing in this repository saw it; the release runner did, in a log
 * nobody reads on a green build ([/decisions/ad-081.md](/decisions/ad-081.md)).
 *
 * invariant: the oracle is npm's own normaliser rather than a rule of ours that guesses what npm dislikes. That
 * closes the class instead of the instance — any field npm would rewrite fails here, not just `bin`.
 */
export type Normaliser = (manifest: string) => string;

/**
 * why: `npm pkg fix` is the command npm's own publish warning tells you to run, so it is the same normaliser that
 * silently rewrote the manifest. It runs against a copy in a temp directory: this must never edit `package.json`,
 * because a gate that fixes what it measures reports success it caused.
 */
/**
 * hazard: on Windows `npm` is `npm.cmd`, and execFile does not consult PATHEXT — the first version threw
 * `spawnSync npm ENOENT` on three tests, only in Windows CI. The same spelling as the npm bump in `runUpdate`, for
 * the same reason. Extracted so the platform branch has a test that does not need the platform
 * ([/decisions/ad-081.md](/decisions/ad-081.md)).
 */
export function npmSpawnOptions(cwd: string, platform: NodeJS.Platform = process.platform) {
  return { cwd, stdio: "ignore", shell: platform === "win32" } as const;
}

export function npmPkgFix(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tlc-manifest-"));
  const path = join(dir, "package.json");
  copyFileSync(manifest, path);
  execFileSync("npm", ["pkg", "fix"], npmSpawnOptions(dir));
  return readFileSync(path, "utf8");
}

export type Manifest = { bin?: Record<string, string> };

/**
 * why: npm validates the *shape* of a bin path and never that the file is there. A bin pointing at a path that
 * does not exist publishes a command that fails on first run, which is worse than one npm removed — the removal
 * at least fails loudly at install time.
 */
export function missingBinTargets(root: string, manifest: Manifest): Violation[] {
  return Object.entries(manifest.bin ?? {})
    .filter(([, target]) => !existsSync(join(root, target)))
    .map(([name, target]) => ({
      rule: "bin-target-missing",
      detail: `\`${name}\` points at \`${target}\`, which does not exist`,
    }));
}

export function checkManifest(root: string, normalise: Normaliser = npmPkgFix): Violation[] {
  const path = join(root, "package.json");
  const declared = readFileSync(path, "utf8");
  const manifest = JSON.parse(declared) as Manifest;
  const violations = missingBinTargets(root, manifest);

  const normalised = normalise(path);
  if (normalised.trim() !== declared.trim()) {
    violations.push({
      rule: "npm-would-correct",
      detail:
        "npm rewrites this manifest on publish, so the published package is not what this file declares. Run `npm pkg fix` and read the diff",
    });
  }
  return violations;
}

export function report(violations: readonly Violation[]): { text: string; ok: boolean } {
  const lines = violations.map((violation) => `  [${violation.rule}]  ${violation.detail}`);
  lines.unshift(
    violations.length === 0
      ? "check-manifest: npm publishes this manifest unchanged, and every bin target exists"
      : `check-manifest: ${violations.length} violation(s)`,
  );
  return { text: lines.join("\n"), ok: violations.length === 0 };
}

if (import.meta.main) {
  const printed = report(checkManifest(repoRoot));
  console.log(printed.text);
  process.exit(printed.ok ? 0 : 1);
}
