import type { AddedLine } from "../../platform/git.ts";
import { lockfilesFor, type ManifestEntry, manifestFor } from "./supply-chain.catalog.ts";

/** why: the stop asks this before reading any diff, so a turn that touched no manifest costs nothing. */
export function isManifest(relativePath: string): boolean {
  return manifestFor(relativePath) !== null;
}

/**
 * What a turn did to the dependency graph.
 *
 * why: a dependency added in a turn is code that runs on every later turn, in CI, and on every machine that
 * installs the project — and it arrives with none of the review the turn's own diff gets. Two mechanical failures
 * are worth a finding; a new dependency as such is not, because a rail that fires on ordinary work is a rail the
 * operator switches off ([/decisions/ad-075.md](/decisions/ad-075.md)).
 */
export type SupplyFinding = {
  kind: "unlocked" | "unpinned";
  file: string;
  line: number;
  detail: string;
};

/** invariant: a specifier that names no version. A range is pinned enough — the lockfile decides the bytes. */
const UNPINNED_SPECS = new Set(["latest", "*", "x", "X", "", "main", "master", "HEAD"]);

/**
 * why: shape-driven rather than parsed. Reading `"name": "spec"` out of an added line needs no JSON parser and
 * survives a diff that shows one line of a larger object — which is the only form a diff ever shows.
 */
export function dependencyOf(
  text: string,
  shape: ManifestEntry["shape"],
): { name: string; spec: string } | null {
  const line = text.trim().replace(/,$/, "");
  switch (shape) {
    case "json-object": {
      const match = /^"([^"]+)"\s*:\s*"([^"]*)"$/.exec(line);
      return match ? { name: match[1] as string, spec: match[2] as string } : null;
    }
    case "toml-table": {
      const match = /^([A-Za-z0-9._-]+)\s*=\s*"([^"]*)"$/.exec(line);
      return match ? { name: match[1] as string, spec: match[2] as string } : null;
    }
    case "requirement": {
      if (line === "" || line.startsWith("#") || line.startsWith("-")) {
        return null;
      }
      const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?:[=<>~!]=?\s*(.+))?$/.exec(line);
      return match ? { name: match[1] as string, spec: (match[2] ?? "").trim() } : null;
    }
    default: {
      // `require github.com/x/y v1.2.3`, `gem "rails", "7.0"`
      const match = /^(?:require|gem)\s+["']?([^"'\s]+)["']?(?:\s*,?\s*["']?([^"'\s]+)["']?)?$/.exec(line);
      return match ? { name: match[1] as string, spec: (match[2] ?? "").trim() } : null;
    }
  }
}

export function isUnpinned(spec: string): boolean {
  const trimmed = spec.trim();
  if (UNPINNED_SPECS.has(trimmed)) {
    return true;
  }
  // invariant: a range is pinned enough, because the lockfile decides the bytes. `^1.2.3` and `~2.0` pass; a bare
  // `>=1` does not, because nothing bounds it above.
  return /^>=?\s*[\d.]+$/.test(trimmed);
}

export type SupplyInput = {
  /** Every path the turn changed, so a lockfile that moved is visible without reading it. */
  changedFiles: readonly string[];
  /** The lines the turn added, in the manifests among those paths. */
  added: readonly AddedLine[];
  /**
   * The manifest as it stands, or null when it cannot be read.
   *
   * hazard: a diff shows one line, so the line alone cannot say which object it sits in. Calibrated against this
   * repository's history, the textual shape read `"name": "harness-toolkit"` from a rename commit as a dependency
   * — and would read every `scripts` entry the same way. The declared names are the only way to tell a dependency
   * from metadata ([/decisions/ad-075.md](/decisions/ad-075.md)).
   */
  readManifest?: (relativePath: string) => string | null;
};

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "require",
  "require-dev",
] as const;

/**
 * why: parsed, not pattern-matched. A JSON manifest is JSON, and the question "is this key a dependency" has an
 * exact answer that a regex over one diff line cannot reach.
 */
export function declaredDependencies(manifestText: string | null): Set<string> | null {
  if (manifestText === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const names = new Set<string>();
  const record = parsed as Record<string, unknown>;
  for (const section of DEPENDENCY_SECTIONS) {
    const block = record[section];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      for (const name of Object.keys(block)) {
        names.add(name);
      }
    }
  }
  return names;
}

export type SupplyOutcome = { findings: SupplyFinding[]; unknownManifests: string[] };

export function inspectSupplyChain(input: SupplyInput): SupplyOutcome {
  const findings: SupplyFinding[] = [];
  const changed = new Set(input.changedFiles.map((path) => path.split(/[\\/]/).pop() ?? path));
  const manifestsTouched = new Map<string, ManifestEntry>();

  for (const path of input.changedFiles) {
    const entry = manifestFor(path);
    if (entry !== null) {
      manifestsTouched.set(path, entry);
    }
  }

  for (const [path, entry] of manifestsTouched) {
    const addedHere = input.added.filter((line) => line.file === path);
    // invariant: for a JSON manifest the declared names decide. An unreadable manifest yields no findings rather
    // than guessing, which is the conservative direction — a missed dependency is quieter than a refused rename.
    const declared =
      entry.shape === "json-object" ? declaredDependencies(input.readManifest?.(path) ?? null) : null;
    const dependencies = addedHere
      .map((line) => ({ line, dependency: dependencyOf(line.text, entry.shape) }))
      .filter((row): row is { line: AddedLine; dependency: { name: string; spec: string } } => {
        if (row.dependency === null) {
          return false;
        }
        if (entry.shape !== "json-object") {
          return true;
        }
        return declared?.has(row.dependency.name) === true;
      });

    // invariant: no added dependency means nothing to answer for. A manifest whose version bumped, or whose
    // scripts changed, has not touched the dependency graph.
    if (dependencies.length === 0) {
      continue;
    }

    const locks = lockfilesFor(entry);
    if (locks.length > 0 && !locks.some((lock) => changed.has(lock))) {
      const head = dependencies[0] as { line: AddedLine };
      findings.push({
        kind: "unlocked",
        file: path,
        line: head.line.line,
        detail: `${path} gained a dependency and none of ${locks.join(", ")} moved, so what installs is decided at install time`,
      });
    }

    for (const { line, dependency } of dependencies) {
      if (isUnpinned(dependency.spec)) {
        findings.push({
          kind: "unpinned",
          file: path,
          line: line.line,
          detail: `${dependency.name} is specified as \`${dependency.spec || "(no version)"}\`, so tomorrow's bytes are not today's`,
        });
      }
    }
  }

  const unknownManifests = input.changedFiles
    .filter((path) => {
      const name = path.split(/[\\/]/).pop() ?? path;
      return /^(?:.*\.)?(?:lock|manifest)$/.test(name) && manifestFor(path) === null;
    })
    .sort();

  return { findings, unknownManifests };
}

export function supplyChainMessage(findings: readonly SupplyFinding[]): string {
  const unlocked = findings.filter((finding) => finding.kind === "unlocked");
  const unpinned = findings.filter((finding) => finding.kind === "unpinned");
  return [
    `BLOCKED: this turn changed the dependency graph in ${findings.length} way(s) that outlive it.`,
    "TRIED: compared the manifest lines this turn added against the commit it started from, and checked",
    "whether the paired lockfile moved with them.",
    ...(unlocked.length > 0
      ? [
          "NEED: run the ecosystem's install so the lockfile records what resolves, and commit it with the manifest.",
        ]
      : []),
    ...(unpinned.length > 0
      ? ["NEED: name a version. `latest` and `*` mean the bytes that arrive tomorrow were never reviewed."]
      : []),
    "If a floating specifier is deliberate, say which and why in one line and continue.",
    "",
    ...findings
      .slice(0, 10)
      .map((finding) => `${finding.file}:${finding.line}  [${finding.kind}]  ${finding.detail}`),
  ].join("\n");
}
