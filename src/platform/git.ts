import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROJECT_HARNESS_PATHSPEC } from "./paths.ts";
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

// why: every worktree of one repository shares this path, unlike `gitRootOf`'s own toplevel, which is
// worktree-specific by design — this is what tells "two worktrees of one repo" apart from "two unrelated repos".
export async function gitCommonDirOf(dir: string): Promise<string | null> {
  let result: { exitCode: number; stdout: string };
  try {
    result = await runProcess({ command: ["git", "rev-parse", "--git-common-dir"], cwd: dir });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }
  const raw = result.stdout.trim();
  if (raw.length === 0) {
    return null;
  }
  // why: `/tmp` and macOS's `/var/folders` are themselves symlinks, so two paths naming the same real
  // directory can disagree as strings unless both are resolved through the same filesystem call.
  try {
    return await realpath(resolve(dir, raw));
  } catch {
    return null;
  }
}

async function scratchTreeId(dir: string, source: "work" | "head"): Promise<string | null> {
  let indexPath: string;
  let objectsPath: string;
  try {
    const located = await runProcess({
      command: ["git", "rev-parse", "--path-format=absolute", "--git-path", "index", "--git-path", "objects"],
      cwd: dir,
    });
    const [index, objects] = located.stdout.trim().split("\n");
    if (located.exitCode !== 0 || !index || !objects) {
      return null;
    }
    indexPath = index;
    objectsPath = objects;
  } catch {
    return null;
  }
  const scratch = mkdtempSync(join(tmpdir(), "tlc-tree-"));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(scratch, "index"),
    GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objectsPath,
  };
  const git = (args: string[]) =>
    runProcess({ command: ["git", "-c", "core.fsmonitor=false", ...args], cwd: dir, env });
  try {
    mkdirSync(env.GIT_OBJECT_DIRECTORY);
    if (source === "head") {
      if ((await git(["read-tree", "HEAD"])).exitCode !== 0) {
        return null;
      }
    } else if (existsSync(indexPath)) {
      copyFileSync(indexPath, env.GIT_INDEX_FILE);
      const original = statSync(indexPath);
      utimesSync(env.GIT_INDEX_FILE, original.atime, original.mtime);
      await git(["add", "-A", "--ignore-errors"]);
    } else if ((await git(["read-tree", "--empty"])).exitCode === 0) {
      await git(["add", "-A", "--ignore-errors"]);
    } else {
      return null;
    }
    await git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", PROJECT_HARNESS_PATHSPEC]);
    const tree = await git(["write-tree"]);
    const id = tree.stdout.trim();
    return tree.exitCode === 0 && id.length > 0 ? id : null;
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function workingTreeId(dir: string): Promise<string | null> {
  return scratchTreeId(dir, "work");
}

export function headTreeId(dir: string): Promise<string | null> {
  return scratchTreeId(dir, "head");
}

export function linkedWorktreeMainRoot(root: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(root, ".git"), "utf8");
  } catch {
    return null;
  }
  const pointer = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!pointer) {
    return null;
  }
  const main = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(resolve(root, pointer))?.[1];
  return main ? main : null;
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
 * why: a merge inside the turn brings lines another author wrote, and a diff against `base` alone cannot tell
 * them from the turn's own — the comment gate blocked a clean `git merge` on 19 upstream docstrings, and a
 * conflicted merge blocked the very `git commit` that would conclude it. A line or file taken verbatim from an
 * incoming side matches that side, so callers keep only what also differs from every parent returned here: the
 * non-first parents of each merge the turn committed on its first-parent line, plus `MERGE_HEAD` while a merge
 * is still open.
 *
 * invariant: no merge in `base..HEAD` and no `MERGE_HEAD` → an empty list, and every caller reads exactly what
 * it read before.
 */
async function incomingMergeParents(root: string, base: string): Promise<string[]> {
  const parents: string[] = [];
  if (base !== "HEAD") {
    const merges = await gitLines(root, [
      "rev-list",
      "--first-parent",
      "--merges",
      "--parents",
      `${base}..HEAD`,
    ]);
    for (const row of merges) {
      parents.push(...row.split(" ").slice(2));
    }
  }
  parents.push(...(await gitLines(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])));
  return parents;
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

  const [againstBase, staged, untracked, incoming] = await Promise.all([
    gitPaths(root, ["diff", "--name-only", "-z", base]),
    gitPaths(root, ["diff", "--name-only", "-z", "--cached"]),
    gitPaths(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
    incomingMergeParents(root, base),
  ]);

  let tracked = new Set([...againstBase, ...staged]);
  for (const parent of incoming) {
    const [worktree, index] = await Promise.all([
      gitPaths(root, ["diff", "--name-only", "-z", parent]),
      gitPaths(root, ["diff", "--name-only", "-z", "--cached", parent]),
    ]);
    const differs = new Set([...worktree, ...index]);
    tracked = new Set([...tracked].filter((path) => differs.has(path)));
  }

  const paths = new Set(tracked);
  for (const path of untracked) {
    paths.add(path);
  }
  return [...paths];
}

export type ShippedRange = {
  base: string | null;
  files: string[];
  aheadOfUpstream: number | null;
  headTree: string | null;
};

async function gitOut(root: string, args: string[]): Promise<string | null> {
  try {
    const result = await runProcess({ command: ["git", ...args], cwd: root });
    const out = result.stdout.trim();
    return result.exitCode === 0 && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function defaultRemoteBranch(root: string): Promise<string | null> {
  const symbolic = await gitOut(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic !== null) {
    return symbolic;
  }
  for (const candidate of ["origin/main", "origin/master"]) {
    if ((await gitOut(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) !== null) {
      return candidate;
    }
  }
  return null;
}

export async function shippedRange(dir: string): Promise<ShippedRange> {
  const root = await gitRootOf(dir);
  if (root === null) {
    return { base: null, files: [], aheadOfUpstream: null, headTree: null };
  }
  const headTree = await headTreeId(root);
  const ahead = await gitOut(root, ["rev-list", "--count", "@{upstream}..HEAD"]);
  const remoteDefault = await defaultRemoteBranch(root);
  const base = remoteDefault !== null ? await gitOut(root, ["merge-base", "HEAD", remoteDefault]) : null;
  const files = base !== null ? await gitPaths(root, ["diff", "--name-only", "-z", base, "HEAD"]) : [];
  return { base, files, aheadOfUpstream: ahead === null ? null : Number(ahead), headTree };
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

// why: shared by `listAddedLines` (a real git-history diff) and `diffProposedAgainstDisk` (a diff of two
// in-memory strings never committed anywhere) — one parser for one diff format, not two.
function parseUnifiedAdded(diffLines: string[], file: string): AddedLine[] {
  const out: AddedLine[] = [];
  let lineNo = 0;
  for (const row of diffLines) {
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
  return out;
}

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
  const [tracked, incoming] = await Promise.all([
    gitPaths(root, ["ls-files", "-z", "--", ...relativePaths]).then((paths) => new Set(paths)),
    incomingMergeParents(root, base),
  ]);
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
    let added = parseUnifiedAdded(await gitLines(root, ["diff", "--unified=0", base, "--", file]), file);
    for (const parent of incoming) {
      if (added.length === 0) {
        break;
      }
      const diff = await gitLines(root, ["diff", "--unified=0", parent, "--", file]);
      const alsoAdded = new Set(parseUnifiedAdded(diff, file).map((row) => `${row.line}\0${row.text}`));
      added = added.filter((row) => alsoAdded.has(`${row.line}\0${row.text}`));
    }
    out.push(...added);
  }
  return out;
}

// hazard: exit 1 means "diff found" here, not failure like every other git call in this file — reusing
// `gitLines` would read every real diff as empty.
async function noIndexDiffLines(fileA: string, fileB: string): Promise<string[]> {
  const result = await runProcess({ command: ["git", "diff", "--no-index", "--unified=0", fileA, fileB] });
  if (result.exitCode >= 2) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// invariant: never writes to `.git/objects` or the working tree — two temp files carry both sides,
// removed in `finally`.
export async function diffTwoStrings(
  currentContent: string,
  proposedContent: string,
  file: string,
): Promise<AddedLine[]> {
  if (currentContent === proposedContent) {
    return [];
  }

  const scratch = mkdtempSync(join(tmpdir(), "tlc-comment-gate-"));
  try {
    const currentPath = join(scratch, "current");
    const proposedPath = join(scratch, "proposed");
    writeFileSync(currentPath, currentContent, "utf8");
    writeFileSync(proposedPath, proposedContent, "utf8");
    const diff = await noIndexDiffLines(currentPath, proposedPath);
    return parseUnifiedAdded(diff, file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function diffProposedAgainstDisk(
  gitRoot: string,
  file: string,
  proposedContent: string,
): Promise<AddedLine[]> {
  let currentContent = "";
  try {
    currentContent = readFileSync(join(gitRoot, file), "utf8");
  } catch {
    currentContent = "";
  }
  return diffTwoStrings(currentContent, proposedContent, file);
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
