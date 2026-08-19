/**
 * How a release tag is spelled.
 *
 * hazard: the changelog generator listed tags with the glob `v*` while every tag this repository has ever created
 * is `harness-toolkit-v…`. It matched none, put all 88 decision records under `## Unreleased`, and passed its own
 * `--check` because the generated document and the committed one were wrong in the same way. Three releases shipped
 * with a changelog attributing nothing to any of them ([/decisions/ad-087.md](/decisions/ad-087.md)).
 *
 * invariant: derived from the package name, which is the same source `release-please-config.json` writes the tag
 * from. A prefix written down twice is a prefix that drifts once.
 */
export function tagPrefixFor(packageName: string): string {
  const unscoped = packageName.includes("/") ? (packageName.split("/").pop() ?? packageName) : packageName;
  return `${unscoped}-v`;
}

export type SemVer = { major: number; minor: number; patch: number };

export function parseVersion(text: string): SemVer | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (match === null) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** The version inside a tag, or null when the tag belongs to another package or another scheme. */
export function versionInTag(packageName: string, tag: string): string | null {
  const prefix = tagPrefixFor(packageName);
  if (!tag.startsWith(prefix)) {
    return null;
  }
  const rest = tag.slice(prefix.length);
  return parseVersion(rest) === null ? null : rest;
}

/**
 * The version a set of commits earns, from Conventional Commit subjects.
 *
 * why: the release writes to `main` directly and publishes before it tags, so nothing assembles the bump in a pull
 * request for a human to look at. The arithmetic therefore has to be a pure function with tests rather than a step
 * inside somebody else's action ([/decisions/ad-087.md](/decisions/ad-087.md)).
 */
export type Bump = "major" | "minor" | "patch" | "none";

export type Commit = {
  /** The subject line, e.g. `fix(gate): …`. */
  subject: string;
  /** The body, where a `BREAKING CHANGE:` footer lives. */
  body?: string;
};

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<rest>.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

/**
 * invariant: `feat` and `fix` are the only types that release. Everything else — `docs`, `chore`, `refactor`,
 * `test`, `ci`, `build`, `perf`, `style` — lands without moving the version. That is what stops the release's own
 * commit from earning the next version and looping, which this pipeline did six times in nine minutes.
 */
export const MINOR_TYPES: ReadonlySet<string> = new Set(["feat"]);
export const PATCH_TYPES: ReadonlySet<string> = new Set(["fix"]);

/**
 * invariant: a scope on this list never releases, whatever the type. `fix(ci)` and `fix(gate)` are repository
 * plumbing that cannot reach anyone who installed the package — three versions were published for exactly that
 * kind of work before this existed.
 */
export const INERT_SCOPES: ReadonlySet<string> = new Set(["ci", "gate", "release", "docs", "deps-dev"]);

export function bumpFor(commit: Commit): Bump {
  const match = SUBJECT.exec(commit.subject.trim());
  if (match?.groups === undefined) {
    return "none";
  }
  const { type, scope, breaking } = match.groups as { type: string; scope?: string; breaking?: string };
  if (scope !== undefined && INERT_SCOPES.has(scope)) {
    return "none";
  }
  if (breaking === "!" || BREAKING_FOOTER.test(commit.body ?? "")) {
    return "major";
  }
  if (MINOR_TYPES.has(type)) {
    return "minor";
  }
  return PATCH_TYPES.has(type) ? "patch" : "none";
}

const RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export function highestBump(commits: readonly Commit[]): Bump {
  return commits.reduce<Bump>((best, commit) => {
    const bump = bumpFor(commit);
    return RANK[bump] > RANK[best] ? bump : best;
  }, "none");
}

/**
 * why: below 1.0.0 a breaking change takes the minor, not the major. Reaching 1.0.0 is a claim about stability that
 * a commit message must not be able to make on its own.
 *
 * hazard: a feature still takes the minor below 1.0.0. Rebasing `feat` down to a patch is a *different* convention
 * and this repository does not use it — the history says so: 0.1.0 went to 0.2.0 on a `feat:`. Implementing both at
 * once would silently renumber every future feature.
 */
export function applyBump(current: SemVer, bump: Bump): SemVer {
  if (bump === "none") {
    return current;
  }
  const effective: Exclude<Bump, "none"> = current.major === 0 && bump === "major" ? "minor" : bump;
  switch (effective) {
    case "major":
      return { major: current.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: current.major, minor: current.minor + 1, patch: 0 };
    default:
      return { major: current.major, minor: current.minor, patch: current.patch + 1 };
  }
}

export type VersionPlan = {
  current: string;
  next: string;
  bump: Bump;
  released: boolean;
  /** The subjects that earned the bump, for the run's log. */
  reasons: string[];
};

export function planVersion(currentVersion: string, commits: readonly Commit[]): VersionPlan {
  const current = parseVersion(currentVersion);
  if (current === null) {
    throw new Error(`release: \`${currentVersion}\` is not a version this can bump`);
  }
  const bump = highestBump(commits);
  return {
    current: formatVersion(current),
    next: formatVersion(applyBump(current, bump)),
    bump,
    released: bump !== "none",
    reasons: commits.filter((commit) => bumpFor(commit) !== "none").map((commit) => commit.subject),
  };
}

export function formatVersion(version: SemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}
