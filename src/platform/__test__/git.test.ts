import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  filterCodeTargets,
  filterTestTargets,
  gitRootOf,
  listAddedLines,
  listChangedRepoFiles,
  listCommitFileSets,
  listTrackedFiles,
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

  /**
   * GRD-05 — a subdirectory used to read as "not a repository" and return no files at all, silently, the same
   * blind spot AD-132 fixes across every function in this file.
   */
  test("GRD-05 returns the identical file list whether called from the root or a real subdirectory", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "committed.ts"), "export const a = 1;\n");
    git(dir, ["add", "committed.ts"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    writeFileSync(join(dir, "committed.ts"), "export const a = 2;\n");
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "untracked.ts"), "export const b = 2;\n");

    const fromRoot = await listChangedRepoFiles(dir);
    const fromSubdir = await listChangedRepoFiles(join(dir, "apps", "web"));

    assert.deepEqual([...fromSubdir].sort(), [...fromRoot].sort());
    assert.equal(fromRoot.includes("apps/web/untracked.ts"), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("listCommitFileSets", () => {
  test("GRD-05 returns the identical commit history whether called from the root or a real subdirectory", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "first"]);
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "b.ts"), "export const b = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "second"]);

    const fromRoot = await listCommitFileSets(dir, 5);
    const fromSubdir = await listCommitFileSets(join(dir, "apps", "web"), 5);

    assert.deepEqual(fromSubdir, fromRoot);
    assert.deepEqual(fromRoot[0], ["apps/web/b.ts"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns an empty array when .git is absent, without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    await assert.doesNotReject(async () => {
      assert.deepEqual(await listCommitFileSets(dir, 5), []);
    });
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

  /**
   * `runCommand` used to truncate to the last 8000 chars itself, duplicating
   * `trimOutputTail`/`OUTPUT_TAIL_MAX` (`gate.artifact.ts`), the one caller that actually needs a bound
   * already applies. `listTrackedFiles` (`git.ts`), the other caller, needs the full output — a complete
   * file list has no "the tail matters more" property ([/decisions/ad-133.md](/decisions/ad-133.md)).
   */
  test("returns the full output untruncated, even past 8000 characters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-command-"));
    const result = await runCommand(dir, ["node", "-e", "process.stdout.write('x'.repeat(9000) + 'END')"]);
    assert.equal(result.output.length, 9003);
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

  test("GRD-06 a tracked file's added lines are identical from a subdirectory as from the root", async () => {
    const dir = initRepo();
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "a.ts"), "export const a = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    writeFileSync(join(dir, "apps", "web", "a.ts"), "// narration\nexport const a = 1;\n");

    const fromRoot = await listAddedLines(dir, ["apps/web/a.ts"], base);
    const fromSubdir = await listAddedLines(join(dir, "apps", "web"), ["apps/web/a.ts"], base);

    assert.deepEqual(fromSubdir, fromRoot);
    assert.deepEqual(
      fromRoot.map((line) => line.text),
      ["// narration"],
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("GRD-06 an untracked file's lines are identical from a subdirectory as from the root", async () => {
    const dir = initRepo();
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "new.ts"), "export const b = 1;\nexport const c = 2;\n");

    const fromRoot = await listAddedLines(dir, ["apps/web/new.ts"]);
    const fromSubdir = await listAddedLines(join(dir, "apps", "web"), ["apps/web/new.ts"]);

    assert.deepEqual(fromSubdir, fromRoot);
    assert.deepEqual(
      fromRoot.map((line) => line.text),
      ["export const b = 1;", "export const c = 2;", ""],
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("GRD-06 returns an empty array when .git is absent, without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    await assert.doesNotReject(async () => {
      assert.deepEqual(await listAddedLines(dir, ["a.ts"]), []);
    });
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

  /**
   * GRD-02 — the exact production incident: this check silently returned null for a real subdirectory of a
   * real repository, letting a pr-open rule never evaluate at all ([/decisions/ad-132.md](/decisions/ad-132.md)).
   */
  test("GRD-02 resolves the same owner/repo from a real subdirectory, not only the exact root", async () => {
    const dir = initRepo();
    git(dir, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
    mkdirSync(join(dir, "apps", "web"), { recursive: true });

    const fromRoot = await localRepoRemote(dir);
    const fromSubdir = await localRepoRemote(join(dir, "apps", "web"));

    assert.deepEqual(fromRoot, { owner: "acme", repo: "widgets" });
    assert.deepEqual(fromSubdir, fromRoot);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("listTrackedFiles", () => {
  /**
   * F2/AD-132 — `git ls-files` scopes its output to the cwd it runs from, unlike `git diff`/`git log`. Run
   * from a real subdirectory it used to return subdirectory-relative names, disagreeing with every other
   * function here that returns repo-root-relative ones.
   */
  test("GRD-09 returns repo-root-relative paths whether called from the root or a real subdirectory", async () => {
    const dir = initRepo();
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    mkdirSync(join(dir, "core"), { recursive: true });
    writeFileSync(join(dir, "core", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "apps", "web", "b.ts"), "export const b = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);

    const fromRoot = await listTrackedFiles(dir);
    const fromSubdir = await listTrackedFiles(join(dir, "apps", "web"));

    assert.deepEqual([...fromSubdir].sort(), [...fromRoot].sort());
    assert.equal(fromRoot.includes("apps/web/b.ts"), true);
    assert.equal(fromRoot.includes("core/a.ts"), true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns an empty array when .git is absent, without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    await assert.doesNotReject(async () => {
      assert.deepEqual(await listTrackedFiles(dir), []);
    });
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Found by review of AD-133's own fix: `git ls-files -z` on a repo with no tracked files exits 0 with empty
   * stdout, and `runCommand` substitutes `NO_OUTPUT_CAPTURED` for that empty string — a sentinel with no NUL
   * byte, which `split("\0")` would otherwise return as a single phantom entry.
   */
  test("returns an empty array for a real repo with no tracked files, not a phantom entry", async () => {
    const dir = initRepo();
    assert.deepEqual(await listTrackedFiles(dir), []);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * TFT-01 — the confirmed bug: `runCommand`'s old `slice(-8000)` truncation kept only the tail of `git
   * ls-files -z`'s output, dropping whichever files sorted first. `a-marker.ts` sorts before every generated
   * file below, so it is exactly the entry the old bug silently lost.
   */
  test("TFT-01 every tracked file survives even when the list exceeds the old 8000-char truncation", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "a-marker.ts"), "export const marker = 1;\n");
    for (let index = 0; index < 400; index += 1) {
      writeFileSync(
        join(dir, `generated-file-${String(index).padStart(4, "0")}.ts`),
        "export const x = 1;\n",
      );
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "large tree"]);

    const lsFilesBytes = execFileSync("git", ["-C", dir, "ls-files", "-z"]).length;
    assert.ok(lsFilesBytes > 8000, `test setup: expected >8000 bytes, got ${lsFilesBytes}`);

    const tracked = await listTrackedFiles(dir);
    assert.equal(tracked.length, 401);
    assert.equal(tracked.includes("a-marker.ts"), true);
    assert.equal(tracked.includes("generated-file-0399.ts"), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * why a marker file instead of string equality: `git rev-parse --show-toplevel` and Node's own path
 * normalization disagree on Windows CI — forward slashes and the long form (`runneradmin`) from git, backslashes
 * and an 8.3 short form (`RUNNER~1`) from `mkdtempSync`/`realpathSync`. Both spellings name the same directory;
 * a marker file readable through the resolved path proves that without caring how either side spells it.
 */
function sameLocation(resolved: string | null, marker: string, expectedContent: string): boolean {
  if (resolved === null) {
    return false;
  }
  try {
    return readFileSync(join(resolved, marker), "utf8") === expectedContent;
  } catch {
    return false;
  }
}

describe("gitRootOf", () => {
  test("GRD-01 resolves the repo root when given the root itself", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "marker.txt"), "root");
    assert.equal(sameLocation(await gitRootOf(dir), "marker.txt", "root"), true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("GRD-01 resolves the same repo root when given a real subdirectory", async () => {
    const dir = initRepo();
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "marker.txt"), "root");
    assert.equal(sameLocation(await gitRootOf(join(dir, "apps", "web")), "marker.txt", "root"), true);
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
    writeFileSync(join(main, "marker.txt"), "main");

    const worktree = mkdtempSync(join(tmpdir(), "git-root-worktree-"));
    rmSync(worktree, { recursive: true, force: true });
    git(main, ["worktree", "add", "-b", "feature-x", worktree]);
    mkdirSync(join(worktree, "apps", "web"), { recursive: true });
    writeFileSync(join(worktree, "marker.txt"), "worktree");

    const resolved = await gitRootOf(join(worktree, "apps", "web"));
    assert.equal(sameLocation(resolved, "marker.txt", "worktree"), true);
    assert.equal(sameLocation(resolved, "marker.txt", "main"), false);

    git(main, ["worktree", "remove", "--force", worktree]);
    rmSync(main, { recursive: true, force: true });
  });
});
