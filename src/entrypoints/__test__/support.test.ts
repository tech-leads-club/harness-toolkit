import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessEvent } from "../../contracts/index.ts";
import { coreFacade } from "../../core/index.ts";
import type { ProviderPort } from "../../providers/index.ts";
import {
  currentGitBranch,
  currentGitSha,
  renderProviderLessonsView,
  resolveTurnBase,
  shaScopeRoot,
} from "../support.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "support-git-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["checkout", "-q", "-b", "feature-x"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

const BASE_EVENT: HarnessEvent = {
  provider: "claude",
  event: "shell.before",
  sessionKey: "claude-probe",
  projectDir: "/main-checkout",
  raw: {},
};

// why: this precedence is the entire AD-114 fix — `event.cwd` is the field the host actually moves
// into a worktree, `event.projectDir` is the one that deliberately does not.
test("shaScopeRoot prefers event.cwd over event.projectDir when both are present", async () => {
  const event: HarnessEvent = { ...BASE_EVENT, cwd: "/main-checkout/.claude/worktrees/feature-x" };
  assert.equal(await shaScopeRoot(event), "/main-checkout/.claude/worktrees/feature-x");
});

test("shaScopeRoot falls back to event.projectDir when cwd is absent and nothing is recalled", async () => {
  assert.equal(
    await shaScopeRoot({ ...BASE_EVENT, projectDir: "/no-such-dir-at-all" }),
    "/no-such-dir-at-all",
  );
});

test("shaScopeRoot returns projectDir unchanged when cwd equals it", async () => {
  const event: HarnessEvent = { ...BASE_EVENT, cwd: "/main-checkout" };
  assert.equal(await shaScopeRoot(event), "/main-checkout");
});

// why: AD-145 — Cursor's `stop` never carries `cwd`; the last real one this same session reported via
// `beforeShellExecution` is the fallback, but only once it is confirmed to be a worktree of the same repo.
test("shaScopeRoot recalls this session's last shell cwd when it is a worktree of the same repo", async () => {
  const main = initRepo();
  const worktreeDir = join(main, "..", `${main.split("/").pop()}-wt`);
  try {
    git(main, ["worktree", "add", "-q", worktreeDir, "-b", "wt-branch"]);
    const event: HarnessEvent = { ...BASE_EVENT, projectDir: main, sessionKey: "recall-probe" };
    await coreFacade.handoff.patchHandoff(main, event.provider, event.sessionKey, {
      slice: { last_shell_cwd: worktreeDir },
    });
    assert.equal(await shaScopeRoot(event), worktreeDir);
  } finally {
    git(main, ["worktree", "remove", "-f", worktreeDir]);
    rmSync(main, { recursive: true, force: true });
  }
});

test("shaScopeRoot ignores a recalled cwd from an unrelated repository", async () => {
  const main = initRepo();
  const unrelated = initRepo();
  try {
    const event: HarnessEvent = { ...BASE_EVENT, projectDir: main, sessionKey: "recall-unrelated" };
    await coreFacade.handoff.patchHandoff(main, event.provider, event.sessionKey, {
      slice: { last_shell_cwd: unrelated },
    });
    assert.equal(await shaScopeRoot(event), main);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(unrelated, { recursive: true, force: true });
  }
});

test("shaScopeRoot ignores a recalled cwd that no longer exists on disk", async () => {
  const main = initRepo();
  try {
    const event: HarnessEvent = { ...BASE_EVENT, projectDir: main, sessionKey: "recall-missing" };
    await coreFacade.handoff.patchHandoff(main, event.provider, event.sessionKey, {
      slice: { last_shell_cwd: join(main, "never-existed") },
    });
    assert.equal(await shaScopeRoot(event), main);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test("GRD-04 currentGitSha resolves the same sha from a real subdirectory as from the root", async () => {
  const dir = initRepo();
  mkdirSync(join(dir, "apps", "web"), { recursive: true });

  const fromRoot = await currentGitSha(dir);
  const fromSubdir = await currentGitSha(join(dir, "apps", "web"));

  assert.notEqual(fromRoot, null);
  assert.equal(fromSubdir, fromRoot);
  rmSync(dir, { recursive: true, force: true });
});

test("GRD-04 currentGitSha is null for a directory with no git repository at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "support-no-git-"));
  assert.equal(await currentGitSha(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test("GRD-04 currentGitBranch resolves the same branch from a real subdirectory as from the root", async () => {
  const dir = initRepo();
  mkdirSync(join(dir, "apps", "web"), { recursive: true });

  const fromRoot = await currentGitBranch(dir);
  const fromSubdir = await currentGitBranch(join(dir, "apps", "web"));

  assert.equal(fromRoot, "feature-x");
  assert.equal(fromSubdir, fromRoot);
  rmSync(dir, { recursive: true, force: true });
});

test("GRD-04 currentGitBranch is null for a directory with no git repository at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "support-no-git-"));
  assert.equal(await currentGitBranch(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test("renderProviderLessonsView returns null for a name no registered provider carries", () => {
  assert.equal(renderProviderLessonsView("no-such-provider", "/tmp"), null);
});

// invariant: a registry entry is dispatched by identity, not by a name this function has to know in advance —
// any `ProviderPort` reaching the array gets its own `lessonsView` called, unedited.
test("a provider present in the registry is dispatched by its lessonsView, unedited", () => {
  const calls: string[] = [];
  const fixture: ProviderPort = {
    name: "fixture-lessons-provider",
    detect: () => false,
    capabilities: () => {
      throw new Error("unused");
    },
    policyDefaults: () => ({ blockedPatterns: [], minEffort: null, untrustedTools: [] }),
    toEvent: () => null,
    render: () => ({ stdout: null, exitCode: 0 }),
    wiring: () => ({ target: "/tmp/fixture-lessons.json", strategy: "replace" as const, entries: [] }),
    wiringTargets: () => ["/tmp/fixture-lessons.json"],
    lessonsView: (root: string) => {
      calls.push(root);
      return "rendered by the fixture";
    },
  };
  const result = renderProviderLessonsView("fixture-lessons-provider", "/tmp/some-root", [fixture]);
  assert.equal(result, "rendered by the fixture");
  assert.deepEqual(calls, ["/tmp/some-root"]);
});

// why: AD-144 — `turn_base_sha` alone cannot tell "captured here" from "captured in an unrelated
// worktree three turns ago." These pin the guard that tells the two apart.
test("resolveTurnBase returns HEAD when no slice is recorded", async () => {
  const dir = initRepo();
  try {
    assert.equal(await resolveTurnBase(undefined, dir), "HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTurnBase returns HEAD when turn_base_sha is set but turn_base_root is missing", async () => {
  const dir = initRepo();
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(await resolveTurnBase({ turn_base_sha: sha }, dir), "HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTurnBase returns the recorded sha when turn_base_root matches the current git root", async () => {
  const dir = initRepo();
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();
    const resolved = await resolveTurnBase({ turn_base_sha: sha, turn_base_root: root }, dir);
    assert.equal(resolved, sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTurnBase returns HEAD when turn_base_root names a different git root than the one being diffed", async () => {
  const capturedIn = initRepo();
  const diffedIn = initRepo();
  try {
    const staleSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: capturedIn,
      encoding: "utf8",
    }).trim();
    const capturedRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: capturedIn,
      encoding: "utf8",
    }).trim();
    const resolved = await resolveTurnBase(
      { turn_base_sha: staleSha, turn_base_root: capturedRoot },
      diffedIn,
    );
    assert.equal(resolved, "HEAD");
  } finally {
    rmSync(capturedIn, { recursive: true, force: true });
    rmSync(diffedIn, { recursive: true, force: true });
  }
});
