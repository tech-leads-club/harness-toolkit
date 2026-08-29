import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectStateDir, runtimeSpoolPath } from "../../platform/paths.ts";
import { compactBeforeHandler } from "../compact-before.ts";
import { promptSubmitHandler } from "../prompt-submit.ts";
import { runHandler } from "../run.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-prompt-compact-"));
}

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

function obsRecords(root: string): Array<Record<string, unknown>> {
  const path = join(projectStateDir(root), "obs.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cursorPromptSubmit(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "beforeSubmitPrompt",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    prompt: "please fix the bug",
    ...overrides,
  });
}

function claudePromptSubmit(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    session_id: "sess-1",
    prompt: "please fix the bug",
    ...overrides,
  });
}

function cursorCompactBefore(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "preCompact",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    ...overrides,
  });
}

function claudeCompactBefore(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PreCompact",
    cwd: root,
    session_id: "sess-1",
    ...overrides,
  });
}

test("prompt.submit emits a provider-tagged obs record under Cursor", async () => {
  const root = tempRoot();
  try {
    await runHandler(promptSubmitHandler, stdinOf(cursorPromptSubmit(root)));
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.provider, "cursor");
    assert.equal(records[0]?.kind, "prompt.submit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt.submit emits a provider-tagged obs record under Claude", async () => {
  const root = tempRoot();
  try {
    await runHandler(promptSubmitHandler, stdinOf(claudePromptSubmit(root)));
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.provider, "claude");
    assert.equal(records[0]?.kind, "prompt.submit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt.submit returns an abstain decision", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(promptSubmitHandler, stdinOf(cursorPromptSubmit(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * why: AD-117 — the exact AD-114 divergence, but against `turn_base_sha` instead of a rule's proof sha.
 * A worktree session's `cwd` differs from `CLAUDE_PROJECT_DIR`; `turn_base_sha` has to reflect the
 * worktree actually being worked on, or every gate that diffs against it reads an untouched file as
 * "added this turn."
 */
const previousProjectDir = process.env.CLAUDE_PROJECT_DIR;

afterEach(() => {
  if (previousProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
  }
});

function gitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", prefix], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  return dir;
}

function headSha(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
}

test("turn_base_sha reflects the event's own cwd, not CLAUDE_PROJECT_DIR", async () => {
  const mainCheckout = gitRepo("tlc-prompt-main-");
  const worktree = gitRepo("tlc-prompt-worktree-");
  process.env.CLAUDE_PROJECT_DIR = mainCheckout;
  try {
    await runHandler(promptSubmitHandler, stdinOf(claudePromptSubmit(worktree)));

    const handoff = coreFacade.handoff.readHandoff(mainCheckout, "claude");
    assert.equal(handoff.turn_base_sha, headSha(worktree));
    assert.notEqual(
      headSha(worktree),
      headSha(mainCheckout),
      "the two repos must genuinely differ to prove anything",
    );
  } finally {
    rmSync(mainCheckout, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("compact.before emits a provider-tagged obs record under Cursor", async () => {
  const root = tempRoot();
  try {
    await runHandler(compactBeforeHandler, stdinOf(cursorCompactBefore(root)));
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.provider, "cursor");
    assert.equal(records[0]?.kind, "compact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compact.before emits a provider-tagged obs record under Claude", async () => {
  const root = tempRoot();
  try {
    await runHandler(compactBeforeHandler, stdinOf(claudeCompactBefore(root)));
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.provider, "claude");
    assert.equal(records[0]?.kind, "compact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compact.before returns an abstain decision", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(compactBeforeHandler, stdinOf(cursorCompactBefore(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compact.before records context_usage_percent when the provider supplies it", async () => {
  const root = tempRoot();
  try {
    await runHandler(compactBeforeHandler, stdinOf(cursorCompactBefore(root, { context_usage_percent: 92 })));
    const records = obsRecords(root);
    const attrs = records[0]?.attrs as Record<string, unknown>;
    assert.equal(attrs.context_usage_percent, 92);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compact.before leaves context_usage_percent absent when the provider does not supply it", async () => {
  const root = tempRoot();
  try {
    await runHandler(compactBeforeHandler, stdinOf(cursorCompactBefore(root)));
    const records = obsRecords(root);
    const attrs = records[0]?.attrs as Record<string, unknown>;
    assert.equal(attrs.context_usage_percent, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unwritable state dir does not fail prompt.submit or compact.before", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
    writeFileSync(join(root, ".tlc", "harness", "state"), "not a directory");
    const promptOutcome = await runHandler(promptSubmitHandler, stdinOf(cursorPromptSubmit(root)));
    const compactOutcome = await runHandler(compactBeforeHandler, stdinOf(cursorCompactBefore(root)));
    assert.equal(promptOutcome.decision.kind, "abstain");
    assert.equal(promptOutcome.rendered.exitCode, 0);
    assert.equal(compactOutcome.decision.kind, "abstain");
    assert.equal(compactOutcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function spoolRecords(): Array<Record<string, unknown>> {
  const path = runtimeSpoolPath();
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("obs.globalSpool off leaves the runtime home untouched", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const previousHome = process.env.TLC_HOME;
  process.env.TLC_HOME = home;
  try {
    await runHandler(promptSubmitHandler, stdinOf(cursorPromptSubmit(root)));
    assert.ok(obsRecords(root).length > 0);
    assert.deepEqual(spoolRecords(), []);
  } finally {
    if (previousHome === undefined) {
      delete process.env.TLC_HOME;
    } else {
      process.env.TLC_HOME = previousHome;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("obs.globalSpool on mirrors the record to the runtime home, tagged with its repo", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const previousHome = process.env.TLC_HOME;
  process.env.TLC_HOME = home;
  try {
    mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
    writeFileSync(
      join(root, ".tlc", "harness", "config.json"),
      JSON.stringify({ version: 1, obs: { globalSpool: true } }),
    );
    await runHandler(promptSubmitHandler, stdinOf(cursorPromptSubmit(root)));
    assert.ok(obsRecords(root).length > 0);
    const spooled = spoolRecords();
    assert.equal(spooled.length, 1);
    assert.equal(spooled[0]?.repo, root);
    assert.equal(spooled[0]?.stream, "obs");
  } finally {
    if (previousHome === undefined) {
      delete process.env.TLC_HOME;
    } else {
      process.env.TLC_HOME = previousHome;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

function debugRecords(root: string): Array<Record<string, unknown>> {
  const path = join(projectStateDir(root), "debug.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("debug records stay absent, since debugEnabled is not a project field", async () => {
  const root = tempRoot();
  try {
    await runHandler(promptSubmitHandler, stdinOf(cursorPromptSubmit(root, { prompt: "x" })));
    assert.equal(debugRecords(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
