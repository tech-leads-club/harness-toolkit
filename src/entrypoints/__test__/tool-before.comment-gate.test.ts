// why: real git repos and the real handler, not a hand-written decision — AD-115 exists because a
// gate that only reports a violation after the fact is not enforcement, so its own test has to
// prove the enforcement, not assert a mock of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { projectConfigPath } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";
import { toolBeforeHandler } from "../tool-before.ts";

let runtimeSandbox: string;
let previousHome: string | undefined;

// why: the same isolation `tool-before.test.ts` already documents — the merged policy must not
// depend on whichever operator's machine happens to run this suite.
before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-comment-gate-home-"));
  previousHome = process.env.TLC_HOME;
  process.env.TLC_HOME = runtimeSandbox;
});

after(() => {
  if (previousHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = previousHome;
  }
  rmSync(runtimeSandbox, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], {
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

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-comment-gate-"));
  git(root, "init", "-q");
  writeFileSync(join(root, "README.md"), "hi\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "one");
  return root;
}

function writeProjectPolicy(root: string, patch: Record<string, unknown>): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(patch, null, 2), "utf8");
}

function withComments(root: string, onViolation: "followup" | "off" = "followup"): void {
  writeProjectPolicy(root, { version: 1, comments: { enabled: true, onViolation, mode: "declared" } });
}

function writeUndeclaredComment(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "index.ts"),
    "export function add(a: number, b: number): number {\n  // adds two numbers\n  return a + b;\n}\n",
    "utf8",
  );
}

const stdinOf = (text: string) => ({ readStdin: () => Promise.resolve(text) });

function claudeShell(root: string, command: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Bash",
    tool_input: { command },
  });
}

describe("commit/push/pr-open refuse an unresolved comment violation", () => {
  test("AC1 git commit is denied when the turn added an undeclared comment", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      writeUndeclaredComment(root);

      const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "git commit -am 'wip'")));

      assert.equal(outcome.decision.kind, "deny");
      assert.equal(
        outcome.decision.kind === "deny" ? outcome.decision.rule : "",
        "comment-policy-before-ship",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AC1 gh pr create is denied the same way", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      writeUndeclaredComment(root);

      const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "gh pr create --fill")));

      assert.equal(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AC2 git commit is allowed when there is no comment violation", async () => {
    const root = tempRepo();
    try {
      withComments(root);

      const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "git commit -am 'wip'")));

      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AC3 onViolation off allows the command even with a violation present", async () => {
    const root = tempRepo();
    try {
      withComments(root, "off");
      writeUndeclaredComment(root);

      const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "git commit -am 'wip'")));

      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AC4 a command that is not commit/push/pr-open is unaffected by a pending violation", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      writeUndeclaredComment(root);

      const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "npm test")));

      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AC5 an operator rule's own denial wins over the comment gate", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      writeUndeclaredComment(root);
      writeProjectPolicy(root, {
        version: 1,
        comments: { enabled: true, onViolation: "followup", mode: "declared" },
        rules: { enabled: true },
      });
      mkdirSync(join(root, ".tlc", "harness", "rules"), { recursive: true });
      writeFileSync(
        join(root, ".tlc", "harness", "rules", "no-commits.md"),
        "---\non: commit\nrequire:\n  - command(never satisfied) since HEAD\notherwise: deny\n---\nNo commits, ever.",
        "utf8",
      );

      const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "git commit -am 'wip'")));

      assert.equal(outcome.decision.kind, "deny");
      assert.equal(outcome.decision.kind === "deny" ? outcome.decision.rule : "", "rule:no-commits");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
