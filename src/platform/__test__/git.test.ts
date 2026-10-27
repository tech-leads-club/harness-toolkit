import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  diffProposedAgainstDisk,
  filterCodeTargets,
  filterTestTargets,
  gitRootOf,
  headTreeId,
  linkedWorktreeMainRoot,
  listAddedLines,
  listChangedRepoFiles,
  listCommitFileSets,
  listTrackedFiles,
  localRepoRemote,
  parseOwnerRepo,
  workingTreeId,
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

  /**
   * hazard: found by review of AD-134's own fix — git quotes and octal-escapes any path containing a
   * non-ASCII byte unless run with `-z` (`"café.ts"` becomes `"caf\303\251.ts"` on the wire), and a leading
   * space survives git's own quoting but not a naive `.trim()`. Both corrupted names miss
   * `filterCodeTargets`'s extension check and vanish from every gate silently
   * ([/decisions/ad-134.md](/decisions/ad-134.md)).
   */
  test("a modified file with a non-ASCII name and one with a leading space both survive intact", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "café.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, " leading-space.ts"), "export const b = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);

    writeFileSync(join(dir, "café.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, " leading-space.ts"), "export const b = 2;\n");

    const changed = await listChangedRepoFiles(dir);
    assert.equal(changed.includes("café.ts"), true);
    assert.equal(changed.includes(" leading-space.ts"), true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a new untracked file with a non-ASCII name survives intact", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);

    writeFileSync(join(dir, "新しい.ts"), "export const b = 1;\n");

    const changed = await listChangedRepoFiles(dir);
    assert.equal(changed.includes("新しい.ts"), true);
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

  /**
   * hazard: the tracked-file check used to read through `gitLines`, whose quoting/`.trim()` corruption made
   * a non-ASCII or leading-space filename mismatch the exact string `relativePaths` passed in — `tracked.has`
   * came back false for an actually-tracked file, misreading its whole current content as newly added instead
   * of diffing it against `base` ([/decisions/ad-134.md](/decisions/ad-134.md)).
   */
  test("a tracked file with a non-ASCII name is diffed against base, not misread as untracked", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "café.ts"), "export const a = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    writeFileSync(join(dir, "café.ts"), "export const a = 1;\n// narration\n");

    const added = await listAddedLines(dir, ["café.ts"], base);
    assert.deepEqual(
      added.map((line) => line.text),
      ["// narration"],
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

function revParse(cwd: string, rev: string): string {
  return execFileSync("git", ["rev-parse", rev], { cwd, encoding: "utf8" }).trim();
}

/**
 * hazard: a merge inside the turn brought another author's committed lines into the diff against the turn's
 * base, so the comment gate blocked a clean merge on upstream docstrings, and a conflicted merge blocked the
 * `git commit` that would have concluded it. Each repo below has a side branch, `theirs`, standing in for the
 * other author.
 */
describe("lines a merge incorporates are not the turn's", () => {
  function repoWithTheirs(): string {
    const dir = initRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "c.ts"), "export const c = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    const ours = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
    git(dir, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(dir, "b.ts"), "// their docstring\nexport const b = 1;\n");
    writeFileSync(join(dir, "c.ts"), "// their note\nexport const c = 2;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "another author"]);
    git(dir, ["checkout", "-q", ours]);
    return dir;
  }

  test("a merge committed inside the turn leaves only the turn's own lines and files", async () => {
    const dir = repoWithTheirs();
    const base = revParse(dir, "HEAD");
    writeFileSync(join(dir, "a.ts"), "// ours, before the merge\nexport const a = 1;\n");
    git(dir, ["commit", "-q", "-am", "the turn's own commit"]);
    git(dir, ["merge", "-q", "--no-edit", "theirs"]);
    writeFileSync(join(dir, "a.ts"), "// ours, before the merge\nexport const a = 1;\n// ours, after\n");

    const added = await listAddedLines(dir, ["a.ts", "b.ts", "c.ts"], base);
    assert.deepEqual(
      added.map((line) => `${line.file}:${line.text}`),
      ["a.ts:// ours, before the merge", "a.ts:// ours, after"],
    );
    assert.deepEqual(await listChangedRepoFiles(dir, base), ["a.ts"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a merge stopped on a conflict counts only the lines the resolution wrote", async () => {
    const dir = repoWithTheirs();
    writeFileSync(join(dir, "c.ts"), "export const c = 3;\n");
    git(dir, ["commit", "-q", "-am", "ours touches c.ts too"]);
    assert.throws(() =>
      execFileSync("git", ["merge", "-q", "--no-edit", "theirs"], { cwd: dir, stdio: "ignore" }),
    );
    writeFileSync(join(dir, "c.ts"), "// their note\n// resolved by the turn\nexport const c = 4;\n");

    const added = await listAddedLines(dir, ["b.ts", "c.ts"]);
    assert.deepEqual(
      added.map((line) => `${line.file}:${line.text}`),
      ["c.ts:// resolved by the turn", "c.ts:export const c = 4;"],
    );
    assert.deepEqual(await listChangedRepoFiles(dir), ["c.ts"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("with no merge, a line that also exists on an unmerged branch still counts", async () => {
    const dir = repoWithTheirs();
    const base = revParse(dir, "HEAD");
    writeFileSync(join(dir, "b.ts"), "// their docstring\nexport const b = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "the turn writes the same file by itself"]);

    const added = await listAddedLines(dir, ["b.ts"], base);
    assert.deepEqual(
      added.map((line) => line.text),
      ["// their docstring", "export const b = 1;"],
    );
    assert.deepEqual(await listChangedRepoFiles(dir, base), ["b.ts"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * CGPD-01 — the mechanism `commentGateBeforeEdit` needs to isolate genuinely new lines out of a full-file
 * `Write` to an EXISTING file, without a false positive on a comment that was already there before this
 * session. Real `git diff --no-index` against two temp files, never the working tree or `.git/objects`.
 */
describe("diffProposedAgainstDisk", () => {
  test("a file that does not exist yet reports every proposed line as added", async () => {
    const root = mkdtempSync(join(tmpdir(), "diff-proposed-"));
    const proposed = "export function add(a, b) {\n  return a + b;\n}\n";

    const added = await diffProposedAgainstDisk(root, "new.ts", proposed);

    assert.deepEqual(
      added.map((line) => ({ line: line.line, text: line.text })),
      [
        { line: 1, text: "export function add(a, b) {" },
        { line: 2, text: "  return a + b;" },
        { line: 3, text: "}" },
      ],
    );
    assert.ok(added.every((line) => line.file === "new.ts"));
    rmSync(root, { recursive: true, force: true });
  });

  test("a pre-existing undeclared comment already on disk is not reported, only the genuine addition is", async () => {
    const root = mkdtempSync(join(tmpdir(), "diff-proposed-"));
    writeFileSync(
      join(root, "existing.ts"),
      "export function add(a, b) {\n  // old comment\n  return a + b;\n}\n",
      "utf8",
    );
    const proposed =
      "export function add(a, b) {\n  // old comment\n  return a + b;\n}\nexport function sub(a, b) {\n  // new comment\n  return a - b;\n}\n";

    const added = await diffProposedAgainstDisk(root, "existing.ts", proposed);

    assert.deepEqual(
      added.map((line) => line.text),
      ["export function sub(a, b) {", "  // new comment", "  return a - b;", "}"],
    );
    assert.equal(
      added.some((line) => line.text === "  // old comment"),
      false,
      "the pre-existing comment must never be reported as an addition",
    );
    rmSync(root, { recursive: true, force: true });
  });

  test("proposed content identical to what is on disk reports no added lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "diff-proposed-"));
    const content = "export const a = 1;\n";
    writeFileSync(join(root, "same.ts"), content, "utf8");

    const added = await diffProposedAgainstDisk(root, "same.ts", content);

    assert.deepEqual(added, []);
    rmSync(root, { recursive: true, force: true });
  });

  test("binary content on both sides does not throw and reports no line-shaped additions", async () => {
    const root = mkdtempSync(join(tmpdir(), "diff-proposed-"));
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2]).toString("latin1"), "utf8");

    await assert.doesNotReject(async () => {
      const added = await diffProposedAgainstDisk(root, "bin.dat", Buffer.from([0, 1, 3]).toString("latin1"));
      assert.deepEqual(added, []);
    });
    rmSync(root, { recursive: true, force: true });
  });

  test("the scratch temp directory is removed after the call, success or failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "diff-proposed-"));
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("tlc-comment-gate-"));

    await diffProposedAgainstDisk(root, "new.ts", "a\nb\n");

    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("tlc-comment-gate-"));
    assert.deepEqual(after, before);
    rmSync(root, { recursive: true, force: true });
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

/**
 * AD-134 — three real bugs (truncation dropping files, an empty repo reading as a phantom entry, a leading
 * space eaten from a real filename) all traced to one cause: this function used to read through `runCommand`
 * (`platform/process.ts`), a display-oriented helper, instead of `runProcess` directly. One consolidated suite
 * proves the structural fix closes all three at once, plus the pre-existing AD-132 subdirectory guarantee.
 */
describe("listTrackedFiles", () => {
  test("GCB-04 every tracked file survives even when the list exceeds the old 8000-char truncation threshold", async () => {
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

  test("GCB-05 returns an empty array for a real repo with no tracked files, never a placeholder entry", async () => {
    const dir = initRepo();
    assert.deepEqual(await listTrackedFiles(dir), []);
    rmSync(dir, { recursive: true, force: true });
  });

  test("GCB-06 a filename with a leading space survives intact", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, " leading-space.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "zz.ts"), "export const b = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);

    const tracked = await listTrackedFiles(dir);

    assert.equal(tracked.includes(" leading-space.ts"), true);
    assert.equal(tracked.includes("leading-space.ts"), false);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * hazard: `git ls-files` scopes its output to the cwd it runs from, unlike `git diff`/`git log`. This
   * regression guard makes sure the structural fix here never reopens the subdirectory bug
   * ([/decisions/ad-132.md](/decisions/ad-132.md)) already closed.
   */
  test("GCB-07 returns repo-root-relative paths whether called from the root or a real subdirectory", async () => {
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

describe("linkedWorktreeMainRoot", () => {
  test("names the main checkout of a linked worktree", () => {
    const main = initRepo();
    const linked = join(mkdtempSync(join(tmpdir(), "git-linked-")), "wt");
    try {
      writeFileSync(join(main, "a.txt"), "a\n");
      git(main, ["add", "a.txt"]);
      git(main, ["commit", "-q", "-m", "init"]);
      git(main, ["worktree", "add", "-q", linked]);
      const found = linkedWorktreeMainRoot(linked);
      assert.ok(found);
      assert.equal(realpathSync.native(found), realpathSync.native(main));
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(dirname(linked), { recursive: true, force: true });
    }
  });

  test("is null for a main checkout and for a directory outside git", () => {
    const main = initRepo();
    const plain = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      assert.equal(linkedWorktreeMainRoot(main), null);
      assert.equal(linkedWorktreeMainRoot(plain), null);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("workingTreeId", () => {
  function committedRepo(): string {
    const dir = initRepo();
    writeFileSync(join(dir, ".gitignore"), "build/\n");
    writeFileSync(join(dir, "a.txt"), "aaa\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
    return dir;
  }

  function headTree(dir: string): string {
    return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  }

  function objectCount(dir: string): string {
    return execFileSync("git", ["count-objects", "-v"], { cwd: dir, encoding: "utf8" });
  }

  test("a clean checkout is identified by the tree of HEAD", async () => {
    const dir = committedRepo();
    try {
      assert.equal(await workingTreeId(dir), headTree(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an edit changes the id, and committing that edit keeps it", async () => {
    const dir = committedRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "changed\n");
      const dirty = await workingTreeId(dir);
      assert.notEqual(dirty, headTree(dir));
      git(dir, ["commit", "-q", "-am", "edit"]);
      assert.equal(dirty, headTree(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a same-size edit inside the index's own timestamp is still seen", async () => {
    const dir = committedRepo();
    try {
      git(dir, ["config", "core.checkStat", "minimal"]);
      git(dir, ["config", "core.trustctime", "false"]);
      const file = join(dir, "a.txt");
      const index = join(dir, ".git", "index");
      const stamp = Math.floor(statSync(index).mtimeMs / 1000) - 10;
      utimesSync(file, stamp, stamp);
      git(dir, ["update-index", "--really-refresh"]);
      writeFileSync(file, "bbb\n");
      utimesSync(file, stamp, stamp);
      utimesSync(index, stamp, stamp);
      assert.notEqual(await workingTreeId(dir), headTree(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("untracked files count and ignored files do not", async () => {
    const dir = committedRepo();
    try {
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "build", "out.js"), "x\n");
      assert.equal(await workingTreeId(dir), headTree(dir));
      writeFileSync(join(dir, "new.txt"), "n\n");
      assert.notEqual(await workingTreeId(dir), headTree(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("computing the id writes nothing into the repository", async () => {
    const dir = committedRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "never added\n");
      writeFileSync(join(dir, "new.txt"), "never added either\n");
      const before = objectCount(dir);
      const index = readFileSync(join(dir, ".git", "index"));
      await workingTreeId(dir);
      assert.equal(objectCount(dir), before);
      assert.deepEqual(readFileSync(join(dir, ".git", "index")), index);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an untracked file that cannot be read is skipped instead of losing the id", {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, async () => {
    const dir = committedRepo();
    try {
      const locked = join(dir, "locked.txt");
      writeFileSync(locked, "secret\n");
      chmodSync(locked, 0o000);
      assert.equal(await workingTreeId(dir), headTree(dir));
    } finally {
      chmodSync(join(dir, "locked.txt"), 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the harness's own files never change the id", async () => {
    const dir = committedRepo();
    try {
      const before = await workingTreeId(dir);
      mkdirSync(join(dir, ".tlc", "harness"), { recursive: true });
      writeFileSync(join(dir, ".tlc", "harness", "lessons.md"), "rewritten by the harness\n");
      assert.equal(await workingTreeId(dir), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with harness files committed, a clean checkout's id equals the id of HEAD", async () => {
    const dir = committedRepo();
    try {
      mkdirSync(join(dir, ".tlc", "harness"), { recursive: true });
      writeFileSync(join(dir, ".tlc", "harness", "config.json"), "{}\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "harness"]);
      const head = await headTreeId(dir);
      assert.ok(head);
      assert.equal(await workingTreeId(dir), head);
      writeFileSync(join(dir, "a.txt"), "edited\n");
      assert.notEqual(await workingTreeId(dir), head);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("outside a repository there is no id", async () => {
    const plain = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      assert.equal(await workingTreeId(plain), null);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
