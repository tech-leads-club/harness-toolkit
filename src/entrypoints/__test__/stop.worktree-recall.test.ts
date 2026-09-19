import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { projectConfigPath } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";
import { stopHandler } from "../stop.ts";
import { toolBeforeHandler } from "../tool-before.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tlc-worktree-recall-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, ".gitignore"), ".tlc/\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function writeProjectPolicy(root: string, patch: Record<string, unknown>): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(patch, null, 2), "utf8");
}

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

function cursorShellAt(root: string, cwd: string, command: string, conversationId: string): string {
  return JSON.stringify({
    hook_event_name: "beforeShellExecution",
    workspace_roots: [root],
    conversation_id: conversationId,
    command,
    cwd,
  });
}

function cursorStop(root: string, conversationId: string): string {
  return JSON.stringify({
    hook_event_name: "stop",
    workspace_roots: [root],
    conversation_id: conversationId,
    status: "completed",
  });
}

const LINT_WANTS_TWO = [
  "node",
  "-e",
  "process.exit(require('fs').readFileSync('src/app.ts', 'utf8').includes('= 2') ? 0 : 1)",
];

// why: the shared-root leak this session's own dogfooding found — a Cursor `stop` never carries `cwd`
// ([/decisions/ad-145.md](/decisions/ad-145.md)), so before this fix every conversation's grind gate ran
// against `workspace_roots[0]` regardless of which worktree that conversation actually shelled into.

test("a Cursor session that shelled into a worktree gets its own grind gate scoped there at stop", async () => {
  const main = initRepo();
  const worktree = join(main, "..", `${main.split("/").pop()}-wt`);
  try {
    git(main, ["worktree", "add", "-q", worktree, "-b", "feature-x"]);
    // why: main's own working tree also has a change, so a fix that fell back to it would still see a
    // non-empty diff and still run the gate — just against the wrong content.
    writeFileSync(join(main, "src", "app.ts"), "export const a = 99;\n");
    writeFileSync(join(worktree, "src", "app.ts"), "export const a = 2;\n");
    writeProjectPolicy(main, { grind: { enabled: true, lintCommand: LINT_WANTS_TWO } });

    await runHandler(toolBeforeHandler, stdinOf(cursorShellAt(main, worktree, "git status", "conv-a")));
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(main, "conv-a")));

    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    git(main, ["worktree", "remove", "-f", worktree]);
    rmSync(main, { recursive: true, force: true });
  }
});

test("a sibling Cursor conversation that never shelled anywhere does not inherit another session's worktree", async () => {
  const main = initRepo();
  const worktree = join(main, "..", `${main.split("/").pop()}-wt`);
  try {
    git(main, ["worktree", "add", "-q", worktree, "-b", "feature-y"]);
    writeFileSync(join(main, "src", "app.ts"), "export const a = 99;\n");
    writeFileSync(join(worktree, "src", "app.ts"), "export const a = 2;\n");
    writeProjectPolicy(main, { grind: { enabled: true, lintCommand: LINT_WANTS_TWO } });

    await runHandler(toolBeforeHandler, stdinOf(cursorShellAt(main, worktree, "git status", "conv-a")));
    const outcome = await runHandler(stopHandler, stdinOf(cursorStop(main, "conv-b")));

    assert.equal(outcome.decision.kind, "continue");
  } finally {
    git(main, ["worktree", "remove", "-f", worktree]);
    rmSync(main, { recursive: true, force: true });
  }
});
