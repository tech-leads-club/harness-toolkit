// why: real git repos and the real handler, not a hand-written decision — this feature moves the comment
// gate to a real pre-edit deny, so its own test has to prove the enforcement, the same discipline
// `tool-before.comment-gate.test.ts` already applies to the sibling commit-time check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectConfigPath } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";
import { toolBeforeHandler } from "../tool-before.ts";

let runtimeSandbox: string;
let previousHome: string | undefined;

before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-comment-edit-gate-home-"));
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
  const root = mkdtempSync(join(tmpdir(), "tlc-comment-edit-gate-"));
  git(root, "init", "-q");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "one");
  return root;
}

function writeProjectPolicy(root: string, patch: Record<string, unknown>): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(patch, null, 2), "utf8");
}

function withComments(
  root: string,
  overrides: {
    enabled?: boolean;
    onViolation?: "followup" | "off";
    mode?: "declared" | "strict" | "resolvable";
  } = {},
): void {
  writeProjectPolicy(root, {
    version: 1,
    comments: {
      enabled: overrides.enabled ?? true,
      onViolation: overrides.onViolation ?? "followup",
      mode: overrides.mode ?? "declared",
    },
  });
}

const stdinOf = (text: string) => ({ readStdin: () => Promise.resolve(text) });

function claudeWrite(root: string, filePath: string, content: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
  });
}

function claudeEdit(root: string, filePath: string, oldString: string, newString: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
  });
}

function cursorWrite(root: string, filePath: string, content: string): string {
  return JSON.stringify({
    hook_event_name: "preToolUse",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
  });
}

function claudeRead(root: string, filePath: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Read",
    tool_input: { file_path: filePath },
  });
}

describe("CGPD-01: Write introducing an undeclared comment into an existing file is denied before it lands", () => {
  test("Claude", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(claudeWrite(root, "src/index.ts", "export const a = 1;\n// added this turn\n")),
      );
      assert.equal(outcome.decision.kind, "deny");
      assert.equal(
        outcome.decision.kind === "deny" ? outcome.decision.rule : "",
        "comment-policy-before-edit",
      );
      assert.match(
        outcome.decision.kind === "deny" ? outcome.decision.reason : "",
        /BLOCKED: this turn added 1 comment/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Cursor", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(cursorWrite(root, "src/index.ts", "export const a = 1;\n// added this turn\n")),
      );
      assert.equal(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("false-positive guard: a pre-existing undeclared comment is not re-flagged by an unrelated Write", async () => {
    const root = tempRepo();
    try {
      writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n// old comment\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "pre-existing undeclared comment");
      withComments(root);

      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(
          claudeWrite(root, "src/index.ts", "export const a = 1;\n// old comment\nexport const b = 2;\n"),
        ),
      );
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CGPD-02: Edit introducing an undeclared comment via new_string is denied", () => {
  test("deny", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(
          claudeEdit(root, "src/index.ts", "export const a = 1;", "export const a = 1;\n// added this turn"),
        ),
      );
      assert.equal(outcome.decision.kind, "deny");
      assert.equal(
        outcome.decision.kind === "deny" ? outcome.decision.rule : "",
        "comment-policy-before-edit",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("abstain guard: old_string not found in the current on-disk file", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(claudeEdit(root, "src/index.ts", "this text is not in the file", "// added this turn")),
      );
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("false-positive guard: a pre-existing comment carried through old_string into new_string for context is not re-flagged", async () => {
    const root = tempRepo();
    try {
      writeFileSync(
        join(root, "src", "index.ts"),
        "// legacy note, written by a human long ago\nexport const a = 1;\n",
      );
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "pre-existing declared-looking comment");
      withComments(root);

      // why: Claude's own Edit tool requires old_string to be unique, so the model routinely widens it with
      // surrounding context (here, the comment above) that it never intended to touch.
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(
          claudeEdit(
            root,
            "src/index.ts",
            "// legacy note, written by a human long ago\nexport const a = 1;",
            "// legacy note, written by a human long ago\nexport const a = 2;",
          ),
        ),
      );
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("regression: relativePath resolves against event.projectDir, not a separately-resolved git root", () => {
  test("a Write to an existing file in a project directory nested inside a larger git repo is diffed correctly, not misread as a brand-new file", async () => {
    const outerRoot = mkdtempSync(join(tmpdir(), "tlc-comment-edit-gate-monorepo-"));
    try {
      git(outerRoot, "init", "-q");
      const projectDir = join(outerRoot, "packages", "app");
      mkdirSync(join(projectDir, "src"), { recursive: true });
      writeFileSync(
        join(projectDir, "src", "index.ts"),
        "// legacy note, written by a human long ago\nexport const a = 1;\n",
      );
      git(outerRoot, "add", ".");
      git(outerRoot, "commit", "-q", "-m", "one");
      withComments(projectDir);

      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(
          claudeWrite(
            projectDir,
            "src/index.ts",
            "// legacy note, written by a human long ago\nexport const a = 2;\n",
          ),
        ),
      );
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(outerRoot, { recursive: true, force: true });
    }
  });
});

describe("CGPD-03: no false positive on a properly declared or absent comment", () => {
  test("a declared comment (why:) is not denied", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(claudeWrite(root, "src/index.ts", "export const a = 1;\n// why: a real reason\n")),
      );
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no comment at all is not denied", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(claudeWrite(root, "src/index.ts", "export const a = 1;\nexport const b = 2;\n")),
      );
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CGPD-04: single policy surface", () => {
  test("comments.enabled false abstains even with an undeclared comment present", async () => {
    const root = tempRepo();
    try {
      withComments(root, { enabled: false });
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(claudeWrite(root, "src/index.ts", "export const a = 1;\n// added this turn\n")),
      );
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("comments.onViolation off abstains even with an undeclared comment present", async () => {
    const root = tempRepo();
    try {
      withComments(root, { onViolation: "off" });
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(claudeWrite(root, "src/index.ts", "export const a = 1;\n// added this turn\n")),
      );
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CGPD-05: an unconfirmed tool_name abstains", () => {
  test("Read is unaffected regardless of file content", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeRead(root, "src/index.ts")));
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MultiEdit is unaffected — spec's own named example of an unconfirmed shape", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: root,
        session_id: "sess-1",
        tool_name: "MultiEdit",
        tool_input: {
          file_path: "src/index.ts",
          edits: [{ old_string: "export const a = 1;", new_string: "// added this turn" }],
        },
      });
      const outcome = await runHandler(toolBeforeHandler, stdinOf(payload));
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("edge case: empty proposedContent is treated as no comment present", () => {
  test("Write with content: '' is not denied", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeWrite(root, "src/index.ts", "")));
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("edge case: a file outside policy.codePaths abstains", () => {
  test("Write to docs/readme.ts with an undeclared comment is not denied", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(claudeWrite(root, "docs/readme.ts", "# doc\n// added this turn\n")),
      );
      assert.notEqual(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CGPD-06: a confirmed tool_name missing its expected field abstains, not a crash", () => {
  test("Write with no content key", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: root,
        session_id: "sess-1",
        tool_name: "Write",
        tool_input: { file_path: "src/index.ts" },
      });
      await assert.doesNotReject(async () => {
        const outcome = await runHandler(toolBeforeHandler, stdinOf(payload));
        assert.notEqual(outcome.decision.kind, "deny");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CGPD-07: an operator rule's own denial wins over this check", () => {
  test("a rule denying every Write call fires before this check ever runs", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      writeProjectPolicy(root, {
        version: 1,
        comments: { enabled: true, onViolation: "followup", mode: "declared" },
        rules: { enabled: true },
      });
      mkdirSync(join(root, ".tlc", "harness", "rules"), { recursive: true });
      writeFileSync(
        join(root, ".tlc", "harness", "rules", "no-writes.md"),
        "---\non: tool(Write)\nrequire:\n  - command(never satisfied) since HEAD\notherwise: deny\n---\nNo writes, ever.",
        "utf8",
      );

      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(claudeWrite(root, "src/index.ts", "export const a = 1;\n")),
      );
      assert.equal(outcome.decision.kind, "deny");
      assert.equal(outcome.decision.kind === "deny" ? outcome.decision.rule : "", "rule:no-writes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CGPD-08: the deny reason is produced by commentViolationMessage verbatim", () => {
  test("byte-identical to a direct call with the same hits/mode", async () => {
    const root = tempRepo();
    try {
      withComments(root);
      const outcome = await runHandler(
        toolBeforeHandler,
        stdinOf(claudeWrite(root, "src/index.ts", "export const a = 1;\n// added this turn\n")),
      );
      assert.equal(outcome.decision.kind, "deny");
      const reason = outcome.decision.kind === "deny" ? outcome.decision.reason : "";
      const expectedHits = [
        {
          file: "src/index.ts",
          line: 2,
          reason: "undeclared comment added this turn",
          text: "// added this turn",
        },
      ];
      const expectedMessage = coreFacade.commentPolicy.commentViolationMessage(expectedHits, "declared");
      const expectedDiagnostic = coreFacade.diagnostics.rootDiagnostic(root);
      assert.equal(reason, `${expectedMessage}\n\n${expectedDiagnostic.footer}`);
      assert.equal(
        outcome.decision.kind === "deny" ? outcome.decision.diagnostic : "",
        expectedDiagnostic.summary,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
