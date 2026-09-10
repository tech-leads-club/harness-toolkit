import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  filterCodeTargets,
  filterTestTargets,
  gitRootOf,
  listAddedLines,
  listChangedRepoFiles,
  localRepoRemote,
  parseOwnerRepo,
  runCommand,
} from "../git.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

describe("listChangedRepoFiles", () => {
  test("returns an empty array when .git is absent, without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    await assert.doesNotReject(async () => {
      const result = await listChangedRepoFiles(dir);
      assert.deepEqual(result, []);
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns untracked and modified files in a real repo", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "committed.ts"), "export const a = 1;\n");
    git(dir, ["add", "committed.ts"]);
    git(dir, ["commit", "-q", "-m", "initial"]);

    writeFileSync(join(dir, "committed.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "untracked.ts"), "export const b = 2;\n");

    const changed = await listChangedRepoFiles(dir);
    assert.equal(changed.includes("committed.ts"), true);
    assert.equal(changed.includes("untracked.ts"), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("filterCodeTargets", () => {
  test("keeps files under configured code path prefixes with known extensions", () => {
    const result = filterCodeTargets(
      ["src/app.ts", "src/app.md", "vendor/lib.ts", "apps/web/index.tsx"],
      ["src", "apps"],
    );
    assert.deepEqual(result, ["src/app.ts", "apps/web/index.tsx"]);
  });

  test("excludes files not under any code path prefix", () => {
    const result = filterCodeTargets(["docs/readme.ts", "scripts/deploy.ts"], ["src", "apps"]);
    assert.deepEqual(result, []);
  });
});

describe("filterTestTargets", () => {
  test("matches .test.ts and .spec.ts files", () => {
    const result = filterTestTargets(["src/foo.test.ts", "src/bar.spec.tsx", "src/foo.ts"]);
    assert.deepEqual(result, ["src/foo.test.ts", "src/bar.spec.tsx"]);
  });
});

describe("runCommand", () => {
  test("returns '(no output captured)' when the command produces no output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-command-"));
    const result = await runCommand(dir, ["node", "-e", ""]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "(no output captured)");
    rmSync(dir, { recursive: true, force: true });
  });

  test("truncates output over 8000 characters, keeping the tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-command-"));
    const result = await runCommand(dir, ["node", "-e", "process.stdout.write('x'.repeat(9000) + 'END')"]);
    assert.equal(result.output.length, 8000);
    assert.equal(result.output.endsWith("END"), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * hazard: both of these diffed against `HEAD`, so a turn that committed moved `HEAD` past its own changes and
 * every stop-time gate read an empty diff and skipped. Reported from a real project whose comment gate was on,
 * strict, and silent, on a turn whose task was named "schema v2 + tests + commit"
 * ([/decisions/ad-058.md](/decisions/ad-058.md)).
 */
describe("the turn's base, not the HEAD at stop", () => {
  test("a file committed inside the turn is still a changed file", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    writeFileSync(join(dir, "a.ts"), "// narration\nexport const a = 2;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "the turn commits its own work"]);

    assert.deepEqual(await listChangedRepoFiles(dir), [], "against HEAD it looks like nothing happened");
    assert.deepEqual(await listChangedRepoFiles(dir, base), ["a.ts"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a comment committed inside the turn is still an added line", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    writeFileSync(join(dir, "a.ts"), "// narration\nexport const a = 2;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "commit inside the turn"]);

    assert.deepEqual(await listAddedLines(dir, ["a.ts"]), [], "against HEAD the comment is invisible");
    const added = await listAddedLines(dir, ["a.ts"], base);
    assert.deepEqual(
      added.map((line) => line.text),
      ["// narration", "export const a = 2;"],
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("an uncommitted change is found from either base", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    writeFileSync(join(dir, "a.ts"), "// narration\nexport const a = 1;\n");

    for (const from of [undefined, base]) {
      const added =
        from === undefined ? await listAddedLines(dir, ["a.ts"]) : await listAddedLines(dir, ["a.ts"], from);
      assert.deepEqual(
        added.map((line) => line.text),
        ["// narration"],
      );
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseOwnerRepo", () => {
  test("ARS reads the SSH form", () => {
    assert.deepEqual(parseOwnerRepo("git@github.com:owner/repo.git"), { owner: "owner", repo: "repo" });
  });

  test("ARS reads the HTTPS form, with or without .git, with or without a trailing slash", () => {
    assert.deepEqual(parseOwnerRepo("https://github.com/owner/repo.git"), { owner: "owner", repo: "repo" });
    assert.deepEqual(parseOwnerRepo("https://github.com/owner/repo"), { owner: "owner", repo: "repo" });
    assert.deepEqual(parseOwnerRepo("https://github.com/owner/repo/"), { owner: "owner", repo: "repo" });
  });

  test("ARS an unparseable string is null, not a guess", () => {
    assert.equal(parseOwnerRepo("not-a-url"), null);
    assert.equal(parseOwnerRepo(""), null);
  });
});

describe("localRepoRemote", () => {
  test("ARS resolves owner/repo from a real git repo's origin", async () => {
    const dir = initRepo();
    git(dir, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
    assert.deepEqual(await localRepoRemote(dir), { owner: "acme", repo: "widgets" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("ARS null when the repo has no such remote", async () => {
    const dir = initRepo();
    assert.equal(await localRepoRemote(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("ARS null when the directory is not a git repo at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-test-non-repo-"));
    assert.equal(await localRepoRemote(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gitRootOf", () => {
  test("GRD-01 resolves the repo root when given the root itself", async () => {
    const dir = initRepo();
    assert.equal(await gitRootOf(dir), dir);
    rmSync(dir, { recursive: true, force: true });
  });

  test("GRD-01 resolves the same repo root when given a real subdirectory", async () => {
    const dir = initRepo();
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    assert.equal(await gitRootOf(join(dir, "apps", "web")), dir);
    rmSync(dir, { recursive: true, force: true });
  });

  test("GRD-03 null when the directory has no git repository at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-root-non-repo-"));
    assert.equal(await gitRootOf(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("GRD-03 null when the directory does not exist on disk", async () => {
    assert.equal(await gitRootOf(join(tmpdir(), "does-not-exist-at-all-xyz")), null);
  });

  /**
   * GRD-07 — a worktree's own subdirectory must resolve to that worktree's own root, never the main
   * checkout's, preserving [/decisions/ad-129.md](/decisions/ad-129.md)'s existing guarantee.
   */
  test("GRD-07 a git worktree's own subdirectory resolves to the worktree's own root, not the main checkout's", async () => {
    const main = initRepo();
    writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
    git(main, ["add", "-A"]);
    git(main, ["commit", "-q", "-m", "initial"]);

    const worktree = mkdtempSync(join(tmpdir(), "git-root-worktree-"));
    rmSync(worktree, { recursive: true, force: true });
    git(main, ["worktree", "add", "-b", "feature-x", worktree]);
    mkdirSync(join(worktree, "apps", "web"), { recursive: true });

    assert.equal(await gitRootOf(join(worktree, "apps", "web")), worktree);
    assert.notEqual(await gitRootOf(join(worktree, "apps", "web")), main);

    git(main, ["worktree", "remove", "--force", worktree]);
    rmSync(main, { recursive: true, force: true });
  });
});
