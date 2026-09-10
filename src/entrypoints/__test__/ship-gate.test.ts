// why: AD-116 runs the same battery stop would (lint, test, docs-when-deny, duplication, comments,
// on:stop rules) before push/pr-open ships it. Every scenario here runs both a Claude-shaped and a
// Cursor-shaped payload, because the whole point is identical behavior on both hosts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectConfigPath } from "../../platform/paths.ts";
import { promptSubmitHandler } from "../prompt-submit.ts";
import { runHandler } from "../run.ts";
import { toolBeforeHandler } from "../tool-before.ts";

const cleanup: string[] = [];
const originalHome = process.env.TLC_HOME;
const originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = originalHome;
  }
  if (originalClaudeProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir;
  }
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function dirtyRepo(): string {
  const dir = newDir("tlc-ship-gate-repo-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".tlc/\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 2;\n");
  return dir;
}

/** A command that exits with a fixed code — deterministic, no real lint/test tool involved. */
function gate(exitCode: number): string[] {
  return [process.execPath, "-e", `process.exit(${exitCode});`];
}

function writePolicy(root: string, patch: Record<string, unknown>): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, ...patch }, null, 2), "utf8");
}

function claudeShip(root: string, command: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Bash",
    tool_input: { command },
  });
}

function cursorShip(root: string, command: string): string {
  return JSON.stringify({
    hook_event_name: "beforeShellExecution",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    command,
    cwd: root,
  });
}

const stdinOf = (text: string) => ({ readStdin: () => Promise.resolve(text) });

// why: reproduces the exact production shape — `CLAUDE_PROJECT_DIR` (event.projectDir) stays at the main
// checkout, while the payload's own `cwd` (event.cwd) tracks the worktree the agent actually works in
// ([/decisions/ad-114.md](/decisions/ad-114.md), [/decisions/ad-129.md](/decisions/ad-129.md)).
function claudeShipInWorktree(mainRoot: string, worktreeRoot: string, command: string): string {
  process.env.CLAUDE_PROJECT_DIR = mainRoot;
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: worktreeRoot,
    session_id: "sess-wt",
    tool_name: "Bash",
    tool_input: { command },
  });
}

function claudePromptSubmitInWorktree(mainRoot: string, worktreeRoot: string): string {
  process.env.CLAUDE_PROJECT_DIR = mainRoot;
  return JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    cwd: worktreeRoot,
    session_id: "sess-wt",
    prompt: "continue",
  });
}

function cursorShipInWorktree(mainRoot: string, worktreeRoot: string, command: string): string {
  return JSON.stringify({
    hook_event_name: "beforeShellExecution",
    workspace_roots: [mainRoot],
    conversation_id: "conv-wt",
    session_id: "sess-wt",
    command,
    cwd: worktreeRoot,
  });
}

/** A real `git worktree`, sharing the main checkout's object database on a divergent branch. */
function addWorktree(mainRoot: string, branch: string): string {
  const worktreeRoot = newDir("tlc-ship-gate-worktree-");
  rmSync(worktreeRoot, { recursive: true, force: true });
  git(mainRoot, "worktree", "add", "-b", branch, worktreeRoot);
  return worktreeRoot;
}

/** Files that exist only in the main checkout, unrelated to anything the worktree session touched. */
function pollutedMainCheckout(mainRoot: string): void {
  mkdirSync(join(mainRoot, "unrelated-stack"), { recursive: true });
  writeFileSync(join(mainRoot, "unrelated-stack", "main.tf"), 'resource "x" "y" {}\n');
  git(mainRoot, "add", ".");
  git(mainRoot, "commit", "-q", "-m", "unrelated main-checkout work");
}

function cleanRepo(): string {
  const dir = newDir("tlc-ship-gate-wt-main-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".tlc/\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

/**
 * AD-129 — the exact production incident: `event.projectDir` (main checkout) stays put per AD-114;
 * `event.cwd` (the worktree) is where the turn's actual files live. Before this fix, the comment/duplication
 * gates diffed `turn_base_sha` (worktree-valid, AD-117) against the *main checkout's* working tree — an
 * unrelated branch's whole file state read as "added this turn."
 */
describe("ship-gate: worktree scoping, AD-129", () => {
  test("WTS-01 the comment gate scans the worktree's tree, not the main checkout's polluted one", async () => {
    const main = cleanRepo();
    const worktree = addWorktree(main, "feature-x");
    writePolicy(main, { comments: { enabled: true, onViolation: "followup", mode: "declared" } });

    // why: turn_base_sha is recorded from the worktree ([/decisions/ad-117.md](/decisions/ad-117.md)) while
    // state lives at the main checkout ([/decisions/ad-114.md](/decisions/ad-114.md)) — the real production
    // shape, reproduced end to end via the real prompt-submit handler.
    await runHandler(promptSubmitHandler, stdinOf(claudePromptSubmitInWorktree(main, worktree)));

    pollutedMainCheckout(main);
    writeFileSync(join(worktree, "src", "app.ts"), "export const a = 1;\n// this explains nothing new\n");

    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShipInWorktree(main, worktree, PUSH)));

    assert.equal(outcome.decision.kind, "deny", JSON.stringify(outcome.decision));
    assert.equal(outcome.decision.kind === "deny" ? outcome.decision.rule : "", "ship-gate-comments");
    const reason = outcome.decision.kind === "deny" ? outcome.decision.reason : "";
    assert.match(reason, /src\/app\.ts/, "names the file the worktree actually changed");
    assert.doesNotMatch(reason, /unrelated-stack/, "never reports the main checkout's unrelated file");
  });

  test("state stays at the main checkout even when git ops run in the worktree", async () => {
    const main = cleanRepo();
    const worktree = addWorktree(main, "feature-state");
    writePolicy(main, { comments: { enabled: true, onViolation: "followup", mode: "declared" } });
    // why: diverge the two HEADs before recording, so a wrong root records a different sha entirely.
    pollutedMainCheckout(main);
    const worktreeHead = execFileSync("git", ["-C", worktree, "rev-parse", "--short", "HEAD"])
      .toString()
      .trim();
    const mainHead = execFileSync("git", ["-C", main, "rev-parse", "--short", "HEAD"]).toString().trim();
    assert.notEqual(worktreeHead, mainHead, "test setup: the two checkouts must actually diverge");

    await runHandler(promptSubmitHandler, stdinOf(claudePromptSubmitInWorktree(main, worktree)));

    const sessionKey = "claude-sess-wt";
    assert.equal(
      existsSync(coreFacade.handoff.handoffSessionPath(main, sessionKey)),
      true,
      "handoff written at the main checkout, per AD-114",
    );
    assert.equal(
      existsSync(coreFacade.handoff.handoffSessionPath(worktree, sessionKey)),
      false,
      "never written into the worktree's own state dir",
    );
    const stored = JSON.parse(
      readFileSync(coreFacade.handoff.handoffSessionPath(main, sessionKey), "utf8"),
    ) as {
      slice: { turn_base_sha?: string };
    };
    assert.equal(
      stored.slice.turn_base_sha,
      worktreeHead,
      "the sha value is the worktree's HEAD, not the main checkout's",
    );

    // why: a real read-side discriminator, not just a file-path assertion. Commit the violation in the
    // worktree *after* turn_base_sha was captured — if computeTurnScope read the seal from the wrong root
    // and fell back to "HEAD", this commit would already be indistinguishable from the base and vanish.
    writeFileSync(join(worktree, "src", "app.ts"), "export const a = 1;\n// this explains nothing new\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "commit the violation after turn_base_sha was captured");

    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShipInWorktree(main, worktree, PUSH)));
    assert.equal(outcome.decision.kind, "deny", JSON.stringify(outcome.decision));
    assert.equal(outcome.decision.kind === "deny" ? outcome.decision.rule : "", "ship-gate-comments");
  });

  test("WTS-02 identical scoping on Cursor's shell-event shape", async () => {
    const main = cleanRepo();
    const worktree = addWorktree(main, "feature-cursor");
    writePolicy(main, { comments: { enabled: true, onViolation: "followup", mode: "declared" } });

    await runHandler(
      promptSubmitHandler,
      stdinOf(
        JSON.stringify({
          hook_event_name: "beforeSubmitPrompt",
          workspace_roots: [main],
          conversation_id: "conv-wt",
          session_id: "sess-wt",
        }),
      ),
    );
    pollutedMainCheckout(main);
    writeFileSync(join(worktree, "src", "app.ts"), "export const a = 1;\n// this explains nothing new\n");

    const outcome = await runHandler(toolBeforeHandler, stdinOf(cursorShipInWorktree(main, worktree, PUSH)));

    // why: Cursor's beforeSubmitPrompt never reports a per-event cwd, so turn_base_sha here is recorded
    // from the main checkout's HEAD (a pre-existing, documented AD-114 limitation, not a regression) — but
    // the worktree branched from that exact commit, so it is still a valid, shared ancestor. The fix under
    // test is *where the diff runs* (shell.before does report cwd), which is what this asserts.
    assert.equal(outcome.decision.kind, "deny", JSON.stringify(outcome.decision));
    assert.equal(outcome.decision.kind === "deny" ? outcome.decision.rule : "", "ship-gate-comments");
  });

  test("WTS-03 no worktree, no divergence: behavior is unchanged from before this fix", async () => {
    const root = dirtyRepo();
    writePolicy(root, { grind: { enabled: true, lintCommand: gate(1) } });

    const claude = await runHandler(toolBeforeHandler, stdinOf(claudeShip(root, PUSH)));
    const cursor = await runHandler(toolBeforeHandler, stdinOf(cursorShip(root, PUSH)));

    assert.equal(claude.decision.kind, "deny");
    assert.equal(cursor.decision.kind, "deny");
    assert.equal(claude.decision.kind === "deny" ? claude.decision.rule : "", "ship-gate-lint");
    assert.equal(cursor.decision.kind === "deny" ? cursor.decision.rule : "", "ship-gate-lint");
  });

  test("WTS-04 duplication scanning reads the worktree's tracked files, not the main checkout's", async () => {
    const main = cleanRepo();
    const worktree = addWorktree(main, "feature-dup");
    writePolicy(main, { duplication: { enabled: true, minRun: 4 } });

    const LOGIC = [
      "const resolved = resolveHome(env);",
      'if (resolved === null) { throw new Error("no home"); }',
      "const config = readConfig(resolved);",
      "const merged = mergeDefaults(config, DEFAULTS);",
    ].join("\n");
    // why: `old.ts` must already be part of the project *before* turn_base_sha is captured, or it counts as
    // "added this turn" too and the self-match filter (SITES_PER_RUN, duplication.service.ts) hides the hit.
    writeFileSync(join(worktree, "src", "old.ts"), `${LOGIC}\n`);
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "add original logic, in the worktree only");

    await runHandler(promptSubmitHandler, stdinOf(claudePromptSubmitInWorktree(main, worktree)));

    writeFileSync(join(worktree, "src", "new.ts"), `${LOGIC}\n`);

    pollutedMainCheckout(main);

    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShipInWorktree(main, worktree, PUSH)));

    assert.equal(outcome.decision.kind, "deny", JSON.stringify(outcome.decision));
    assert.equal(outcome.decision.kind === "deny" ? outcome.decision.rule : "", "ship-gate-duplication");
  });
});

const PUSH = "git push";
const PR_MERGE = "gh pr merge 42";

describe("ship-gate: commit/push/pr-open run the same battery stop would, before shipping", () => {
  test("AC lint failure denies push, identically on Claude and Cursor", async () => {
    const root = dirtyRepo();
    writePolicy(root, { grind: { enabled: true, lintCommand: gate(1) } });

    const claude = await runHandler(toolBeforeHandler, stdinOf(claudeShip(root, PUSH)));
    const cursor = await runHandler(toolBeforeHandler, stdinOf(cursorShip(root, PUSH)));

    assert.equal(claude.decision.kind, "deny");
    assert.equal(cursor.decision.kind, "deny");
    assert.equal(claude.decision.kind === "deny" ? claude.decision.rule : "", "ship-gate-lint");
    assert.equal(cursor.decision.kind === "deny" ? cursor.decision.rule : "", "ship-gate-lint");
  });

  test("AC lint passing but test failing denies push, identically on both hosts", async () => {
    const root = dirtyRepo();
    writePolicy(root, { grind: { enabled: true, lintCommand: gate(0), testCommand: gate(1) } });

    const claude = await runHandler(toolBeforeHandler, stdinOf(claudeShip(root, PUSH)));
    const cursor = await runHandler(toolBeforeHandler, stdinOf(cursorShip(root, PUSH)));

    assert.equal(claude.decision.kind, "deny");
    assert.equal(cursor.decision.kind, "deny");
    assert.equal(claude.decision.kind === "deny" ? claude.decision.rule : "", "ship-gate-test");
    assert.equal(cursor.decision.kind === "deny" ? cursor.decision.rule : "", "ship-gate-test");
  });

  test("AC docs severity deny blocks push; docs severity warn does not", async () => {
    const failing = dirtyRepo();
    writePolicy(failing, { docs: { command: gate(1), severity: "deny" } });
    const denied = await runHandler(toolBeforeHandler, stdinOf(claudeShip(failing, PUSH)));
    assert.equal(denied.decision.kind, "deny");
    assert.equal(denied.decision.kind === "deny" ? denied.decision.rule : "", "ship-gate-docs");

    const warned = dirtyRepo();
    writePolicy(warned, { docs: { command: gate(1), severity: "warn" } });
    const allowed = await runHandler(toolBeforeHandler, stdinOf(claudeShip(warned, PUSH)));
    assert.notEqual(allowed.decision.kind, "deny");
  });

  test("AC duplication hit denies push, identically on both hosts", async () => {
    const LOGIC = [
      "const resolved = resolveHome(env);",
      'if (resolved === null) { throw new Error("no home"); }',
      "const config = readConfig(resolved);",
      "const merged = mergeDefaults(config, DEFAULTS);",
      "validate(merged);",
      "return merged;",
    ].join("\n");

    const root = newDir("tlc-ship-gate-dup-");
    git(root, "init", "-q");
    writeFileSync(join(root, ".gitignore"), ".tlc/\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "old.ts"), `${LOGIC}\n`);
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "initial");
    writeFileSync(join(root, "src", "new.ts"), `${LOGIC}\n`);
    writePolicy(root, { duplication: { enabled: true, minRun: 6 } });

    const claude = await runHandler(toolBeforeHandler, stdinOf(claudeShip(root, PUSH)));
    const cursor = await runHandler(toolBeforeHandler, stdinOf(cursorShip(root, PUSH)));

    assert.equal(claude.decision.kind, "deny");
    assert.equal(cursor.decision.kind, "deny");
    assert.equal(claude.decision.kind === "deny" ? claude.decision.rule : "", "ship-gate-duplication");
    assert.equal(cursor.decision.kind === "deny" ? cursor.decision.rule : "", "ship-gate-duplication");
  });

  test("AC an on:stop operator rule denies push, identically on both hosts", async () => {
    const root = dirtyRepo();
    writePolicy(root, { rules: { enabled: true } });
    mkdirSync(join(root, ".tlc", "harness", "rules"), { recursive: true });
    writeFileSync(
      join(root, ".tlc", "harness", "rules", "no-ship.md"),
      "---\non: stop\nrequire:\n  - command(never satisfied) since HEAD\notherwise: deny\n---\nNever ship.",
      "utf8",
    );

    const claude = await runHandler(toolBeforeHandler, stdinOf(claudeShip(root, PUSH)));
    const cursor = await runHandler(toolBeforeHandler, stdinOf(cursorShip(root, PUSH)));

    assert.equal(claude.decision.kind, "deny");
    assert.equal(cursor.decision.kind, "deny");
    assert.equal(claude.decision.kind === "deny" ? claude.decision.rule : "", "rule:no-ship");
    assert.equal(cursor.decision.kind === "deny" ? cursor.decision.rule : "", "rule:no-ship");
  });

  test("AC a clean turn allows push on both hosts", async () => {
    const root = dirtyRepo();
    writePolicy(root, { grind: { enabled: true, lintCommand: gate(0), testCommand: gate(0) } });

    const claude = await runHandler(toolBeforeHandler, stdinOf(claudeShip(root, PUSH)));
    const cursor = await runHandler(toolBeforeHandler, stdinOf(cursorShip(root, PUSH)));

    assert.notEqual(claude.decision.kind, "deny");
    assert.notEqual(cursor.decision.kind, "deny");
  });

  /** APIG-14 — pr-merge joins FULL_BATTERY_KINDS, so it pays the same battery push/pr-open already do. */
  test("APIG-14 a pr-merge also pays the full battery, identically on both hosts", async () => {
    const root = dirtyRepo();
    writePolicy(root, { grind: { enabled: true, lintCommand: gate(1) } });

    const claude = await runHandler(toolBeforeHandler, stdinOf(claudeShip(root, PR_MERGE)));
    const cursor = await runHandler(toolBeforeHandler, stdinOf(cursorShip(root, PR_MERGE)));

    assert.equal(claude.decision.kind, "deny");
    assert.equal(cursor.decision.kind, "deny");
    assert.equal(claude.decision.kind === "deny" ? claude.decision.rule : "", "ship-gate-lint");
    assert.equal(cursor.decision.kind === "deny" ? cursor.decision.rule : "", "ship-gate-lint");
  });

  test("AC a bare commit does not pay for the full battery — only the cheap comment check applies", async () => {
    const root = dirtyRepo();
    writePolicy(root, { grind: { enabled: true, lintCommand: gate(1) } });

    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShip(root, "git commit -am 'wip'")));

    assert.notEqual(outcome.decision.kind, "deny");
  });
});

/**
 * AD-130 — the exact production incident: a `gh api` push targeting an unrelated repository was gated by
 * this repo's own stale local state. The full battery must never fire for a repo this checkout's remote
 * does not name.
 */
describe("ship-gate: gh api push is scoped to the local checkout's own remote, AD-130", () => {
  test("ARS-01/02 an unrelated repository's gh api push never pays the full battery, even with a real local failure", async () => {
    const root = dirtyRepo();
    git(root, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    writePolicy(root, { grind: { enabled: true, lintCommand: gate(1) } });

    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(
        claudeShip(
          root,
          "gh api -X PATCH repos/other-owner/unrelated-repo/git/refs/heads/main -f sha=deadbeef",
        ),
      ),
    );

    assert.notEqual(
      outcome.decision.kind,
      "deny",
      "a lint failure in this checkout must not gate a push to a different repository",
    );
  });

  test("ARS-01 the same shape targeting this checkout's own remote still pays the battery", async () => {
    const root = dirtyRepo();
    git(root, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    writePolicy(root, { grind: { enabled: true, lintCommand: gate(1) } });

    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(claudeShip(root, "gh api -X PATCH repos/acme/widgets/git/refs/heads/main -f sha=deadbeef")),
    );

    assert.equal(outcome.decision.kind, "deny", JSON.stringify(outcome.decision));
    assert.equal(outcome.decision.kind === "deny" ? outcome.decision.rule : "", "ship-gate-lint");
  });
});
