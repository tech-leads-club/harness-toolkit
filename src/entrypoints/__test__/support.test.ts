import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessEvent } from "../../contracts/index.ts";
import type { ProviderPort } from "../../providers/index.ts";
import { currentGitBranch, currentGitSha, renderProviderLessonsView, shaScopeRoot } from "../support.ts";

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
test("shaScopeRoot prefers event.cwd over event.projectDir when both are present", () => {
  const event: HarnessEvent = { ...BASE_EVENT, cwd: "/main-checkout/.claude/worktrees/feature-x" };
  assert.equal(shaScopeRoot(event), "/main-checkout/.claude/worktrees/feature-x");
});

test("shaScopeRoot falls back to event.projectDir when cwd is absent", () => {
  assert.equal(shaScopeRoot(BASE_EVENT), "/main-checkout");
});

test("shaScopeRoot returns projectDir unchanged when cwd equals it", () => {
  const event: HarnessEvent = { ...BASE_EVENT, cwd: "/main-checkout" };
  assert.equal(shaScopeRoot(event), "/main-checkout");
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
