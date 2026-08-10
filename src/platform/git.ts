import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "./process.ts";
import { normalizeSeparators } from "./sanitize.ts";

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
 * why: `base` is the revision the turn started at, not `HEAD`. A turn that commits moves `HEAD` past its own
 * changes, so every gate reading this list saw an empty diff and skipped — measured on a real turn whose task
 * was named "schema v2 + tests + commit" ([/decisions/ad-058.md](/decisions/ad-058.md)).
 *
 * invariant: `HEAD` stays the default, so a caller with no recorded base behaves exactly as before.
 */
export async function listChangedRepoFiles(projectDir: string, base = "HEAD"): Promise<string[]> {
  if (!existsSync(join(projectDir, ".git"))) {
    return [];
  }

  const batches = await Promise.all([
    gitLines(projectDir, ["diff", "--name-only", base]),
    gitLines(projectDir, ["diff", "--name-only", "--cached"]),
    gitLines(projectDir, ["ls-files", "--others", "--exclude-standard"]),
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
  if (!existsSync(join(projectDir, ".git")) || limit <= 0) {
    return [];
  }
  // why: one git call for all commits. A separate call per commit is the obvious shape and is an order of
  // magnitude slower on the history sizes this is used for.
  const lines = await gitLines(projectDir, [
    "log",
    `-${limit}`,
    "--name-only",
    "--no-renames",
    "--format=%x00",
  ]);

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
  if (!existsSync(join(projectDir, ".git")) || relativePaths.length === 0) {
    return [];
  }
  const tracked = new Set(await gitLines(projectDir, ["ls-files", "--", ...relativePaths]));
  const out: AddedLine[] = [];

  for (const file of relativePaths) {
    if (!tracked.has(file)) {
      let raw = "";
      try {
        raw = readFileSync(join(projectDir, file), "utf8");
      } catch {
        continue;
      }
      raw.split(/\r?\n/).forEach((text, index) => {
        out.push({ file, line: index + 1, text });
      });
      continue;
    }
    const diff = await gitLines(projectDir, ["diff", "--unified=0", base, "--", file]);
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

export type CommandResult = { exitCode: number; output: string; durationMs: number };

export async function runCommand(
  projectDir: string,
  command: string[],
  extraArgs: string[] = [],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  if (command.length === 0) {
    return { exitCode: 0, output: "", durationMs: 0 };
  }
  const started = Date.now();
  const result = await runProcess({
    command: [...command, ...extraArgs],
    cwd: projectDir,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  const combined = (result.stdout + result.stderr).trim();
  const maxChars = 8000;
  const output =
    combined.length === 0
      ? "(no output captured)"
      : combined.length <= maxChars
        ? combined
        : combined.slice(-maxChars);
  return {
    exitCode: result.exitCode,
    output,
    durationMs: Date.now() - started,
  };
}
