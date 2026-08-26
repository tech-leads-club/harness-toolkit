import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectStateDir } from "../../platform/paths.ts";
import { providers } from "../../providers/index.ts";
import { runHandler } from "../run.ts";
import { toolAfterHandler } from "../tool-after.ts";
import { toolFailureHandler } from "../tool-failure.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-tool-after-"));
}

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function obsRecords(root: string): Array<Record<string, unknown>> {
  return readJsonl(join(projectStateDir(root), "obs.jsonl"));
}

function allRecords(root: string): Array<Record<string, unknown>> {
  return [...obsRecords(root), ...readJsonl(join(projectStateDir(root), "debug.jsonl"))];
}

function auditRecords(root: string): Array<Record<string, unknown>> {
  return readJsonl(join(projectStateDir(root), "audit.jsonl"));
}

function debugRecords(root: string): Array<Record<string, unknown>> {
  return readJsonl(join(projectStateDir(root), "debug.jsonl"));
}

function cursorToolAfter(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "postToolUse",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    tool_name: "Grep",
    ...overrides,
  });
}

function claudeToolAfter(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Grep",
    ...overrides,
  });
}

function repoWithCommittedFile(relativePath: string, committedContent: string): string {
  const dir = tempRoot();
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, ".gitignore"), ".tlc/\n");
  mkdirSync(join(dir, relativePath, ".."), { recursive: true });
  writeFileSync(join(dir, relativePath), committedContent);
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  return dir;
}

function writeCommentsPolicy(root: string, patch: Record<string, unknown> = {}): void {
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  writeFileSync(
    join(root, ".tlc", "harness", "config.json"),
    JSON.stringify({ version: 1, comments: { enabled: true, ...patch } }),
  );
}

function claudeEditAfter(root: string, filePath: string): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  });
}

function writeUntrustedPolicy(root: string): void {
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  writeFileSync(
    join(root, ".tlc", "harness", "config.json"),
    JSON.stringify({ version: 1, untrustedContent: { enabled: true } }),
  );
}

function cursorShellAfter(root: string, command: string): string {
  return JSON.stringify({
    hook_event_name: "afterShellExecution",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    command,
    cwd: root,
    sandbox: true,
  });
}

function claudeShellAfter(root: string, command: string): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Bash",
    tool_input: { command },
    sandbox: false,
  });
}

function cursorToolFailure(root: string): string {
  return JSON.stringify({
    hook_event_name: "postToolUseFailure",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    tool_name: "Read",
  });
}

test("tool.after emits a provider-tagged obs record", async () => {
  const root = tempRoot();
  try {
    await runHandler(toolAfterHandler, stdinOf(cursorToolAfter(root)));
    const records = allRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.provider, "cursor");
    assert.equal(records[0]?.kind, "tool.end");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.after returns an abstain decision", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(toolAfterHandler, stdinOf(cursorToolAfter(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.failure emits a provider-tagged obs record with kind tool.fail", async () => {
  const root = tempRoot();
  try {
    await runHandler(toolFailureHandler, stdinOf(cursorToolFailure(root)));
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.provider, "cursor");
    assert.equal(records[0]?.kind, "tool.fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.failure returns an abstain decision", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(toolFailureHandler, stdinOf(cursorToolFailure(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell.after is audited with command, cwd, and sandbox under Cursor", async () => {
  const root = tempRoot();
  try {
    await runHandler(toolAfterHandler, stdinOf(cursorShellAfter(root, "ls -la")));
    const records = allRecords(root);
    assert.equal(records.length, 1);
    const attrs = records[0]?.attrs as Record<string, unknown>;
    assert.equal(attrs.command, "ls -la");
    assert.equal(attrs.cwd, root);
    assert.equal(attrs.sandbox, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell.after is audited with command, cwd, and sandbox under Claude", async () => {
  const root = tempRoot();
  try {
    await runHandler(toolAfterHandler, stdinOf(claudeShellAfter(root, "npm test")));
    const records = allRecords(root);
    assert.equal(records.length, 1);
    const attrs = records[0]?.attrs as Record<string, unknown>;
    assert.equal(attrs.command, "npm test");
    assert.equal(attrs.cwd, root);
    assert.equal(attrs.sandbox, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit.after emits a file.edit obs record", async () => {
  const root = tempRoot();
  try {
    await runHandler(
      toolAfterHandler,
      stdinOf(
        cursorToolAfter(root, {
          hook_event_name: "afterFileEdit",
          tool_name: undefined,
          file_path: "src/x.ts",
        }),
      ),
    );
    const records = allRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "file.edit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp.after emits an mcp.end obs record", async () => {
  const root = tempRoot();
  try {
    await runHandler(
      toolAfterHandler,
      stdinOf(cursorToolAfter(root, { hook_event_name: "afterMCPExecution", tool_name: "mcp__thing__call" })),
    );
    const records = allRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "mcp.end");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unwritable state dir does not fail tool.after", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
    writeFileSync(join(root, ".tlc", "harness", "state"), "not a directory");
    const outcome = await runHandler(toolAfterHandler, stdinOf(cursorToolAfter(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unwritable state dir does not fail tool.failure", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
    writeFileSync(join(root, ".tlc", "harness", "state"), "not a directory");
    const outcome = await runHandler(toolFailureHandler, stdinOf(cursorToolFailure(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cost estimation resolves usage and cost from a Claude transcript at tool.after", async () => {
  const root = tempRoot();
  const priceHome = mkdtempSync(join(tmpdir(), "tlc-price-home-"));
  const originalHome = process.env.TLC_HOME;
  try {
    process.env.TLC_HOME = priceHome;
    writeFileSync(
      join(priceHome, "model-prices.json"),
      // the one catalogue, with the vendor's own rates in the fallback plane
      JSON.stringify({
        _meta: { refreshedAt: "2026-08-19T00:00:00.000Z" },
        planes: {
          litellm: {
            "claude-sonnet-5": {
              promptPer1M: 3,
              completionPer1M: 15,
              pool: "provider_native",
              billing: "metered",
            },
          },
        },
      }),
    );
    const transcriptPath = join(root, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ message: { usage: { input_tokens: 1000, output_tokens: 500 } } })}\n`,
    );
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(
        claudeToolAfter(root, {
          model: "claude-sonnet-5",
          transcript_path: transcriptPath,
        }),
      ),
    );
    assert.equal(outcome.decision.kind, "abstain");
    const records = allRecords(root);
    assert.equal(records.length, 1);
    const genAi = records[0]?.gen_ai as Record<string, unknown>;
    assert.equal(genAi.input_tokens, 1000);
    assert.equal(genAi.output_tokens, 500);
    assert.equal(genAi.cost_usd, (1000 / 1_000_000) * 3 + (500 / 1_000_000) * 15);
  } finally {
    if (originalHome === undefined) {
      delete process.env.TLC_HOME;
    } else {
      process.env.TLC_HOME = originalHome;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(priceHome, { recursive: true, force: true });
  }
});

test("shell.after writes an audit.jsonl record with the raw payload", async () => {
  const root = tempRoot();
  try {
    await runHandler(toolAfterHandler, stdinOf(cursorShellAfter(root, "ls -la")));
    const records = auditRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.event, "shell.after");
    const payload = records[0]?.payload as Record<string, unknown>;
    assert.equal(payload.command, "ls -la");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.after writes an audit.jsonl record", async () => {
  const root = tempRoot();
  try {
    await runHandler(toolAfterHandler, stdinOf(cursorToolAfter(root)));
    const records = auditRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.event, "tool.after");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool.failure writes an audit.jsonl record", async () => {
  const root = tempRoot();
  try {
    await runHandler(toolFailureHandler, stdinOf(cursorToolFailure(root)));
    const records = auditRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.event, "tool.failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cost estimation is skipped when usage arrives in the payload (Cursor)", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(cursorToolAfter(root, { transcript_path: join(root, "does-not-matter.jsonl") })),
    );
    assert.equal(outcome.decision.kind, "abstain");
    const records = allRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.gen_ai, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untrustedContent off means a web fetch changes nothing", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(claudeToolAfter(root, { tool_name: "WebFetch" })),
    );
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untrustedContent on frames the first fetch of the turn as data", async () => {
  const root = tempRoot();
  try {
    writeUntrustedPolicy(root);
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(claudeToolAfter(root, { tool_name: "WebFetch" })),
    );
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.match(outcome.decision.text, /UNTRUSTED CONTENT/);
      assert.match(outcome.decision.text, /prompt-injection/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second fetch in the same turn stays silent", async () => {
  const root = tempRoot();
  try {
    writeUntrustedPolicy(root);
    const first = await runHandler(
      toolAfterHandler,
      stdinOf(claudeToolAfter(root, { tool_name: "WebFetch" })),
    );
    const second = await runHandler(
      toolAfterHandler,
      stdinOf(claudeToolAfter(root, { tool_name: "WebFetch" })),
    );
    assert.equal(first.decision.kind, "context");
    assert.equal(second.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ordinary tool never triggers the framing", async () => {
  const root = tempRoot();
  try {
    writeUntrustedPolicy(root);
    const outcome = await runHandler(toolAfterHandler, stdinOf(claudeToolAfter(root, { tool_name: "Read" })));
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// hazard: the framing is only worth returning if the provider can carry it on this event. No degrade path
// reads contextAtToolAfter, so the handler has to check it or the rail reports a protection it never gave.
test("the framing is skipped when the provider cannot carry context on tool.after", async () => {
  const root = tempRoot();
  try {
    writeUntrustedPolicy(root);
    const provider = providers[0];
    assert.ok(provider);
    const capable = provider.capabilities();
    // why: the tool has to be one this provider actually treats as untrusted, or the handler would abstain
    // for the wrong reason and the test would pass with the capability check removed.
    const untrustedTool = provider.policyDefaults().untrustedTools[0];
    assert.ok(untrustedTool);
    const decision = await toolAfterHandler(
      {
        provider: provider.name,
        event: "tool.after",
        sessionKey: "sess-1",
        projectDir: root,
        toolName: untrustedTool,
        raw: {},
      },
      {
        policy: coreFacade.policy.loadPolicy(root),
        capabilities: { ...capable, contextAtToolAfter: false },
        provider,
        now: new Date(),
      },
    );
    assert.equal(decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// hazard: the dead "observability" section advertised maxAttrChars for months while nothing read it. This
// drives the replacement through a real hook, so a field that fails to reach the runtime fails here.
test("obs.maxAttrChars from project policy truncates what the hook records", async () => {
  const wide = tempRoot();
  const narrow = tempRoot();
  try {
    const command = `echo ${"z".repeat(400)}`;
    await runHandler(toolAfterHandler, stdinOf(cursorShellAfter(wide, command)));

    mkdirSync(join(narrow, ".tlc", "harness"), { recursive: true });
    writeFileSync(
      join(narrow, ".tlc", "harness", "config.json"),
      JSON.stringify({ version: 1, obs: { maxAttrChars: 30 } }),
    );
    await runHandler(toolAfterHandler, stdinOf(cursorShellAfter(narrow, command)));

    // why: audit.jsonl records the raw payload and never passes through truncateAttrs, so the assertion has
    // to read the plane recordObs writes — shell.end resolves to debug level on an allowed command.
    const wideLength = JSON.stringify(debugRecords(wide)[0]?.attrs ?? {}).length;
    const narrowLength = JSON.stringify(debugRecords(narrow)[0]?.attrs ?? {}).length;
    assert.ok(wideLength > 0 && narrowLength > 0, "both hooks recorded something");
    assert.ok(narrowLength < wideLength, `expected ${narrowLength} < ${wideLength}`);
  } finally {
    rmSync(wide, { recursive: true, force: true });
    rmSync(narrow, { recursive: true, force: true });
  }
});

// AC1/AC2/AC3: an edit that adds an undeclared comment gets a non-blocking heads-up, not a BLOCKED refusal.
test("edit.after advises, without blocking, when the edit added an undeclared comment", async () => {
  const root = repoWithCommittedFile("src/app.ts", "export const a = 1;\n");
  try {
    writeCommentsPolicy(root);
    writeFileSync(
      join(root, "src", "app.ts"),
      "export const a = 1;\n// this sets a to one\nexport const b = 2;\n",
    );
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(claudeEditAfter(root, join(root, "src/app.ts"))),
    );
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.match(outcome.decision.text, /HEADS UP/);
      assert.doesNotMatch(outcome.decision.text, /BLOCKED/);
      assert.match(outcome.decision.text, /src\/app\.ts:2/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit.after stays silent when the added comment declares why:", async () => {
  const root = repoWithCommittedFile("src/app.ts", "export const a = 1;\n");
  try {
    writeCommentsPolicy(root);
    writeFileSync(
      join(root, "src", "app.ts"),
      "export const a = 1;\n// why: matches the schema field name exactly.\nexport const b = 2;\n",
    );
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(claudeEditAfter(root, join(root, "src/app.ts"))),
    );
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC5: no new config surface — the advisory only fires under the exact condition stop's gate already uses.
test("edit.after stays silent when the comment gate is disabled", async () => {
  const root = repoWithCommittedFile("src/app.ts", "export const a = 1;\n");
  try {
    writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n// this sets a to one\n");
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(claudeEditAfter(root, join(root, "src/app.ts"))),
    );
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit.after stays silent when onViolation is off", async () => {
  const root = repoWithCommittedFile("src/app.ts", "export const a = 1;\n");
  try {
    writeCommentsPolicy(root, { onViolation: "off" });
    writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n// this sets a to one\n");
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(claudeEditAfter(root, join(root, "src/app.ts"))),
    );
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC6: scoped to the file this edit touched — a standing violation elsewhere must not surface here.
test("edit.after does not report a violation in a different, untouched file", async () => {
  const root = repoWithCommittedFile("src/app.ts", "export const a = 1;\nexport const c = 3;\n");
  try {
    writeCommentsPolicy(root);
    writeFileSync(
      join(root, "src", "app.ts"),
      "export const a = 1;\n// this sets a to one\nexport const c = 3;\n",
    );
    mkdirSync(join(root, "src", "other"), { recursive: true });
    writeFileSync(join(root, "src", "other", "clean.ts"), "export const d = 4;\n");
    execFileSync("git", ["add", "src/other/clean.ts"], { cwd: root });
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(claudeEditAfter(root, join(root, "src/other/clean.ts"))),
    );
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit.after stays silent for a file outside codePaths", async () => {
  const root = repoWithCommittedFile("scripts/x.ts", "export const a = 1;\n");
  try {
    writeCommentsPolicy(root);
    writeFileSync(join(root, "scripts", "x.ts"), "export const a = 1;\n// this sets a to one\n");
    const outcome = await runHandler(
      toolAfterHandler,
      stdinOf(claudeEditAfter(root, join(root, "scripts/x.ts"))),
    );
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
