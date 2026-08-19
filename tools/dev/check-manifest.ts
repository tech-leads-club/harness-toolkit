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

/**
 * The paths a release is allowed to ignore have to be paths a release cannot change.
 *
 * why: `exclude-paths` in `release-please-config.json` stops a commit that touches only those paths from earning a
 * version — which is right, because 0.2.1, 0.2.2 and 0.2.3 were all CI, gate and packaging work that changed
 * nothing for anyone installing the package. The rule is only true while those paths stay out of the tarball; the
 * day one of them ships, a change would reach users with no version to name it
 * ([/decisions/ad-090.md](/decisions/ad-090.md)).
 */
export type PackedFiles = () => string[];

type PackReport = { files?: { path: string }[] };

/**
 * hazard: npm 12 returns an object keyed by package name; npm 11 and earlier return an array. The first version of
 * this read `parsed[0].files` and got `undefined` on npm 12, so it reported zero packed files and the check passed
 * on everything — the same shape as the two dead rails found in the changelog the same day. An empty answer is
 * therefore an error here, never a verdict ([/decisions/ad-090.md](/decisions/ad-090.md)).
 */
export function parsePackReport(json: string): string[] {
  const parsed = JSON.parse(json) as PackReport[] | Record<string, PackReport>;
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const files = report?.files;
  if (files === undefined || files.length === 0) {
    throw new Error(
      "check-manifest: `npm pack --dry-run --json` reported no files. Its shape has changed and this check would silently pass",
    );
  }
  return files.map((file) => file.path);
}

export function packedFiles(root: string): string[] {
  return parsePackReport(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      // hazard: `npm` is `npm.cmd` on Windows and execFile does not consult PATHEXT
      // ([/decisions/ad-081.md](/decisions/ad-081.md)).
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

export function excludedPaths(root: string): string[] {
  try {
    const config = JSON.parse(readFileSync(join(root, "release-please-config.json"), "utf8")) as {
      packages?: Record<string, { "exclude-paths"?: string[] }>;
    };
    return config.packages?.["."]?.["exclude-paths"] ?? [];
  } catch {
    return [];
  }
}

export function checkReleaseExclusions(excluded: readonly string[], packed: readonly string[]): Violation[] {
  return excluded
    .filter((path) => packed.some((entry) => entry === path || entry.startsWith(`${path}/`)))
    .map((path) => ({
      rule: "excluded-path-is-published",
      detail: `\`${path}\` is in release-please's exclude-paths and ships in the package — a change to it would reach users with no version`,
    }));
}

export function checkManifest(
  root: string,
  normalise: Normaliser = npmPkgFix,
  packed: PackedFiles = () => packedFiles(root),
): Violation[] {
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
  // why: `packed()` shells out to npm, so it is only called when there is something to compare against. A
  // repository with no release config has no exclusions and needs no tarball listing.
  const excluded = excludedPaths(root);
  if (excluded.length > 0) {
    violations.push(...checkReleaseExclusions(excluded, packed()));
  }
  return violations;
}

export function report(violations: readonly Violation[]): { text: string; ok: boolean } {
  const lines = violations.map((violation) => `  [${violation.rule}]  ${violation.detail}`);
  lines.unshift(
    violations.length === 0
      ? "check-manifest: npm publishes this manifest unchanged, every bin target exists, and no release-excluded path ships"
      : `check-manifest: ${violations.length} violation(s)`,
  );
  return { text: lines.join("\n"), ok: violations.length === 0 };
}

if (import.meta.main) {
  const printed = report(checkManifest(repoRoot));
  console.log(printed.text);
  process.exit(printed.ok ? 0 : 1);
}
