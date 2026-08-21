/**
 * An inert scope claims the change cannot reach anyone who installed the package. This checks the claim.
 *
 * why it exists: `fix(gate)` never releases, by design — `ci`, `gate`, `release`, `docs` and `deps-dev` are
 * repository plumbing, and three versions were published for exactly that kind of work before the rule existed. The
 * rule has no counterpart: nothing checked that a commit wearing an inert scope was actually plumbing. One that
 * fixed `tools/doctor.ts` — a file the package ships — shipped anyway, because everything on `main` ships, and
 * earned nothing. It only reached operators because an unrelated `fix` happened to be sitting there to carry it
 * ([/decisions/ad-103.md](/decisions/ad-103.md), [/decisions/ad-098.md](/decisions/ad-098.md)).
 *
 * invariant: documentation is exempt. `docs/` and every `.md` file are in the published payload and change no
 * behaviour, so a `docs`-scoped commit touching them is telling the truth.
 *
 * why a range and not the working tree: this reads commits, so it runs where a base exists — the pull request. It
 * is not a step of `tlc harness test`, which has no base to compare against.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INERT_SCOPES, MINOR_TYPES, PATCH_TYPES } from "../../src/core/release/release.version.ts";
import { normalizeSeparators } from "../../src/platform/sanitize.ts";
import { parsePackReport } from "./verify-package.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<rest>.+)$/;

/** Documentation ships and changes no behaviour, so touching it is never evidence against an inert scope. */
export function changesBehaviour(path: string): boolean {
  return !(path.endsWith(".md") || path.startsWith("docs/"));
}

/**
 * The scope, but only where it decides anything.
 *
 * why the type is read too: an inert scope only matters on a type that would otherwise release. `chore(release)` is
 * the release bot's own commit and has to stay inert — that is what stops the pipeline releasing itself for ever —
 * and reporting it would be reporting the mechanism as the defect.
 */
export function decidingScope(subject: string): string | null {
  const groups = SUBJECT.exec(subject.trim())?.groups;
  if (groups === undefined) {
    return null;
  }
  const releases = MINOR_TYPES.has(groups.type ?? "") || PATCH_TYPES.has(groups.type ?? "");
  return releases ? (groups.scope ?? null) : null;
}

/**
 * The paths npm would publish, as npm resolves them.
 *
 * why npm and not the `files` array read by hand: those globs have semantics — a bare directory means everything
 * under it, `!` subtracts, and `**` is not the only wildcard. A second implementation of that is a second thing to
 * be wrong, and it would be wrong in the safe-looking direction.
 */
export function publishedPaths(cwd: string): Set<string> {
  const packed = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd,
    encoding: "utf8",
    // why stderr is captured rather than inherited: npm narrates the dry run, and that narration is not the report.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const report = parsePackReport(packed) as { files?: { path: string }[] } | null;
  return new Set((report?.files ?? []).map((file) => file.path));
}

export type Violation = { sha: string; subject: string; scope: string; paths: string[] };

export function violations(range: string, published: Set<string>, cwd: string): Violation[] {
  const listed = execFileSync("git", ["log", range, "--format=%H"], { cwd, encoding: "utf8" }).trim();
  const shas = listed.length === 0 ? [] : listed.split("\n");
  const found: Violation[] = [];

  for (const sha of shas) {
    const subject = execFileSync("git", ["log", "-1", "--format=%s", sha], { cwd, encoding: "utf8" }).trim();
    const scope = decidingScope(subject);
    if (scope === null || !INERT_SCOPES.has(scope)) {
      continue;
    }
    const touched = execFileSync("git", ["show", "--name-only", "--format=", sha], { cwd, encoding: "utf8" })
      .split("\n")
      .map((path) => normalizeSeparators(path.trim()))
      .filter((path) => path.length > 0);
    const shipped = touched.filter((path) => published.has(path) && changesBehaviour(path));
    if (shipped.length > 0) {
      found.push({ sha: sha.slice(0, 7), subject, scope, paths: shipped });
    }
  }
  return found;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--base");
  const base = at < 0 ? "origin/main" : (process.argv[at + 1] ?? "origin/main");
  const published = publishedPaths(repoRoot);
  const found = violations(`${base}..HEAD`, published, repoRoot);

  if (found.length === 0) {
    console.log(
      `check-scopes: every inert scope in ${base}..HEAD touches only what the package does not ship`,
    );
    process.exit(0);
  }

  for (const violation of found) {
    console.error(
      `check-scopes: ${violation.sha} "${violation.subject}"\n` +
        `  scope \`${violation.scope}\` never releases, but this commit changes code the package ships:\n` +
        violation.paths.map((path) => `    ${path}`).join("\n"),
    );
  }
  console.error(
    "\nAn inert scope means an operator cannot reach the change. Use a scope that releases, or split the commit.",
  );
  process.exit(1);
}
