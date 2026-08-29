// why: AD-116 runs the same battery stop would (lint, test, docs-when-deny, duplication, comments,
// on:stop rules) before push/pr-open ships it. Every scenario here runs both a Claude-shaped and a
// Cursor-shaped payload, because the whole point is identical behavior on both hosts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { projectConfigPath } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";
import { toolBeforeHandler } from "../tool-before.ts";

const cleanup: string[] = [];
const originalHome = process.env.TLC_HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = originalHome;
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

const PUSH = "git push";

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

  test("AC a bare commit does not pay for the full battery — only the cheap comment check applies", async () => {
    const root = dirtyRepo();
    writePolicy(root, { grind: { enabled: true, lintCommand: gate(1) } });

    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShip(root, "git commit -am 'wip'")));

    assert.notEqual(outcome.decision.kind, "deny");
  });
});
