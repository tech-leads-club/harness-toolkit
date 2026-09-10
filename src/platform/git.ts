import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "./process.ts";
import { normalizeSeparators } from "./sanitize.ts";

/**
 * why: `existsSync(join(dir, ".git"))` requires `.git` to exist *exactly* at `dir` — it does not discover a
 * repository root the way git itself does, walking upward from any subdirectory. A directory genuinely inside
 * a real repository read as "not a repository" by every caller that used that check, silently
 * ([/decisions/ad-132.md](/decisions/ad-132.md)).
 *
 * invariant: `git rev-parse --show-toplevel` already handles every case this project would otherwise have to
 * reimplement — a subdirectory, a worktree's own subdirectory, a missing path, a genuinely absent repository —
 * so nothing here special-cases any of them.
 */
export async function gitRootOf(dir: string): Promise<string | null> {
  // why: every other caller in this file used to check `existsSync` first, which absorbed a missing directory
  // silently. This function is now the first thing that runs when the directory does not exist at all —
  // `spawn` rejects instead of resolving a non-zero exit code for that case, a different failure shape than
  // "not a repository" ([/decisions/ad-132.md](/decisions/ad-132.md)).
  let result: { exitCode: number; stdout: string };
  try {
    result = await runProcess({ command: ["git", "rev-parse", "--show-toplevel"], cwd: dir });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root.length > 0 ? root : null;
}

async function gitLines(projectDir: string, args: string[]): Promise<string[]> {
  const result = await runProcess({ command: ["git", ...args], cwd: projectDir });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * hazard: `gitLines`' `\n`-split and per-line `.trim()` both corrupt a file path — git quotes and
 * octal-escapes any name with a non-ASCII byte when not run with `-z` (`"café.ts"` becomes
 * `"caf\303\251.ts"`), and `.trim()` separately eats a real leading space. Every call site here that reads
 * paths passes its own `-z` (position matters: before any `--` pathspec separator, never after) and splits on
 * NUL instead ([/decisions/ad-134.md](/decisions/ad-134.md)).
 */
async function gitPaths(projectDir: string, args: string[]): Promise<string[]> {
  const result = await runProcess({ command: ["git", ...args], cwd: projectDir });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.split("\0").filter((path) => path !== "");
}

/**
 * why: `base` is the revision the turn started at, not `HEAD`. A turn that commits moves `HEAD` past its own
 * changes, so every gate reading this list saw an empty diff and skipped — measured on a real turn whose task
 * was named "schema v2 + tests + commit" ([/decisions/ad-058.md](/decisions/ad-058.md)).
 *
 * invariant: `HEAD` stays the default, so a caller with no recorded base behaves exactly as before.
 */
export async function listChangedRepoFiles(projectDir: string, base = "HEAD"): Promise<string[]> {
  const root = await gitRootOf(projectDir);
  if (root === null) {
    return [];
  }

  const batches = await Promise.all([
    gitPaths(root, ["diff", "--name-only", "-z", base]),
    gitPaths(root, ["diff", "--name-only", "-z", "--cached"]),
    gitPaths(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);

  const paths = new Set<string>();
  for (const batch of batches) {
    for (const path of batch) {
      paths.add(path);
    }
  }
  return [...paths];
}

/**
 * File lists for the most recent commits, newest first. One entry per commit, so a caller can replay a rule
 * over history without knowing how git formats anything.
 */
export async function listCommitFileSets(projectDir: string, limit: number): Promise<string[][]> {
  if (limit <= 0) {
    return [];
  }
  const root = await gitRootOf(projectDir);
  if (root === null) {
    return [];
  }
  // why: one git call for all commits. A separate call per commit is the obvious shape and is an order of
  // magnitude slower on the history sizes this is used for.
  const lines = await gitLines(root, ["log", `-${limit}`, "--name-only", "--no-renames", "--format=%x00"]);

  const commits: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === "\u0000") {
      current = [];
      commits.push(current);
      continue;
    }
    current?.push(line);
  }
  return commits.filter((files) => files.length > 0);
}

export type AddedLine = {
  file: string;
  line: number;
  text: string;
};

export async function listAddedLines(
  projectDir: string,
  relativePaths: string[],
  base = "HEAD",
): Promise<AddedLine[]> {
  if (relativePaths.length === 0) {
    return [];
  }
  const root = await gitRootOf(projectDir);
  if (root === null) {
    return [];
  }
  const tracked = new Set(await gitPaths(root, ["ls-files", "-z", "--", ...relativePaths]));
  const out: AddedLine[] = [];

  for (const file of relativePaths) {
    if (!tracked.has(file)) {
      let raw = "";
      try {
        raw = readFileSync(join(root, file), "utf8");
      } catch {
        continue;
      }
      raw.split(/\r?\n/).forEach((text, index) => {
        out.push({ file, line: index + 1, text });
      });
      continue;
    }
    const diff = await gitLines(root, ["diff", "--unified=0", base, "--", file]);
    let lineNo = 0;
    for (const row of diff) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (hunk) {
        lineNo = Number(hunk[1]);
        continue;
      }
      if (row.startsWith("+++")) {
        continue;
      }
      if (row.startsWith("+")) {
        out.push({ file, line: lineNo, text: row.slice(1) });
        lineNo += 1;
      }
    }
  }
  return out;
}

function isUnderPrefixes(relativePath: string, prefixes: string[]): boolean {
  const normalized = normalizeSeparators(relativePath);
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export function filterCodeTargets(relativePaths: string[], codePaths: string[]): string[] {
  return relativePaths.filter((path) => {
    if (!isUnderPrefixes(path, codePaths)) {
      return false;
    }
    return /\.(ts|tsx|js|jsx|json|mjs|cjs|py|go|rs)$/.test(path);
  });
}

export function filterTestTargets(relativePaths: string[]): string[] {
  return relativePaths.filter((path) => /\.(spec|test)\.(ts|tsx|js|jsx)$/.test(path));
}

/**
 * Every tracked file, so a duplication scan reads what the project owns and nothing it ignores.
 *
 * why: `git ls-files` already honours `.gitignore`, so `node_modules` and build output cost nothing to exclude
 * and no second ignore list has to be kept in step ([/decisions/ad-071.md](/decisions/ad-071.md)).
 * hazard: reads through `gitPaths`, never `runCommand` (`platform/process.ts`), which trims and
 * placeholder-substitutes for human display — three real defects came from this function reusing that helper
 * for exact, structured data instead ([/decisions/ad-134.md](/decisions/ad-134.md)).
 */
export async function listTrackedFiles(projectDir: string): Promise<string[]> {
  const root = await gitRootOf(projectDir);
  if (root === null) {
    return [];
  }
  return gitPaths(root, ["ls-files", "-z"]);
}

export type RepoRef = { owner: string; repo: string };

/**
 * why: both SSH (`git@host:owner/repo.git`) and HTTPS (`https://host/owner/repo(.git)?`) forms share the same
 * tail shape — a `/` or `:` before the owner, a `/` before the repo, an optional `.git` and trailing slash.
 * One pattern reads both without a URL parser this project has no other use for.
 */
export function parseOwnerRepo(url: string): RepoRef | null {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? { owner: match[1] as string, repo: match[2] as string } : null;
}

/**
 * why a fixed remote name: every repository this project has touched, including this one, names its own
 * remote `origin` — a configurable name is generality nobody has asked for yet
 * ([/decisions/ad-130.md](/decisions/ad-130.md)).
 */
export async function localRepoRemote(projectDir: string, remoteName = "origin"): Promise<RepoRef | null> {
  const root = await gitRootOf(projectDir);
  if (root === null) {
    return null;
  }
  const result = await runProcess({ command: ["git", "remote", "get-url", remoteName], cwd: root });
  return result.exitCode === 0 ? parseOwnerRepo(result.stdout.trim()) : null;
}
