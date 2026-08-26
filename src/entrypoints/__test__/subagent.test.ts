import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectConfigPath } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";
import { subagentStartHandler } from "../subagent-start.ts";
import { subagentStopHandler } from "../subagent-stop.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-subagent-"));
}

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

function writeProjectPolicy(root: string, patch: Record<string, unknown>): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(patch, null, 2), "utf8");
}

function cursorSubagentStart(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "subagentStart",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    subagent_type: "worker",
    subagent_model: "composer-2.5",
    ...overrides,
  });
}

function claudeSubagentStart(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "SubagentStart",
    cwd: root,
    session_id: "sess-1",
    subagent_type: "worker",
    model: "claude-sonnet-5",
    ...overrides,
  });
}

function cursorSubagentStop(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "subagentStop",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    subagent_type: "worker",
    ...overrides,
  });
}

function claudeSubagentStop(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "SubagentStop",
    cwd: root,
    session_id: "sess-1",
    subagent_type: "worker",
    ...overrides,
  });
}

test("a blocked subagent model is denied under Cursor", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      subagentStartHandler,
      stdinOf(cursorSubagentStart(root, { subagent_model: "worker-fast" })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a blocked subagent model is denied under Claude with the identical reason text as Cursor", async () => {
  const cursorRoot = tempRoot();
  const claudeRoot = tempRoot();
  try {
    const cursorOutcome = await runHandler(
      subagentStartHandler,
      stdinOf(cursorSubagentStart(cursorRoot, { subagent_model: "worker-fast" })),
    );
    const claudeOutcome = await runHandler(
      subagentStartHandler,
      stdinOf(claudeSubagentStart(claudeRoot, { model: "worker-fast" })),
    );
    assert.equal(cursorOutcome.decision.kind, "deny");
    assert.equal(claudeOutcome.decision.kind, "deny");
    if (cursorOutcome.decision.kind === "deny" && claudeOutcome.decision.kind === "deny") {
      assert.equal(cursorOutcome.decision.reason, claudeOutcome.decision.reason);
    }
  } finally {
    rmSync(cursorRoot, { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("a subagent spawn is denied when the sticky parent state is Fast ([/decisions/ad-001.md](/decisions/ad-001.md))", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { subagents: { blockParentFast: true } });
    coreFacade.subagentPolicy.upsertParentModelState(root, "cursor-conv-1", { model: "composer-2.5-fast" }, [
      "-fast(?:$|[^a-z0-9])",
    ]);
    const outcome = await runHandler(
      subagentStartHandler,
      stdinOf(cursorSubagentStart(root, { subagent_model: "composer-2.5" })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a subagent spawn with no model is denied when requireModel is enabled", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { subagents: { requireModel: true } });
    const outcome = await runHandler(
      subagentStartHandler,
      stdinOf(cursorSubagentStart(root, { subagent_model: "" })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a subagent spawn on a non-allowlisted model is denied when enforceAllowlist is enabled", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { subagents: { enforceAllowlist: true, allowedModels: ["only-this-one"] } });
    const outcome = await runHandler(
      subagentStartHandler,
      stdinOf(cursorSubagentStart(root, { subagent_model: "something-else" })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a subagent spawn's minEffort violation is denied under Claude", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { subagents: { minEffort: "high" } });
    const outcome = await runHandler(
      subagentStartHandler,
      stdinOf(claudeSubagentStart(root, { effort: { level: "low" } })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a subagent spawn's minEffort check is skipped under Cursor, which reports no effort", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { subagents: { minEffort: "high" } });
    const outcome = await runHandler(subagentStartHandler, stdinOf(cursorSubagentStart(root)));
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unblocked, allowlisted subagent spawn is allowed under Cursor", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(subagentStartHandler, stdinOf(cursorSubagentStart(root)));
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unblocked, allowlisted subagent spawn is allowed under Claude", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(subagentStartHandler, stdinOf(claudeSubagentStart(root)));
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent.stop with unfinished work yields continue (followup_message) under Cursor", async () => {
  const root = tempRoot();
  try {
    await coreFacade.handoff.patchHandoff(root, "cursor", { slice: { blockers: "still failing lint" } });
    const outcome = await runHandler(subagentStopHandler, stdinOf(cursorSubagentStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    assert.match(String(outcome.rendered.stdout), /"followup_message"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subagent.stop with unfinished work yields {"decision":"block"} under Claude', async () => {
  const root = tempRoot();
  try {
    await coreFacade.handoff.patchHandoff(root, "claude", { slice: { blockers: "still failing lint" } });
    const outcome = await runHandler(subagentStopHandler, stdinOf(claudeSubagentStop(root)));
    assert.equal(outcome.decision.kind, "continue");
    assert.match(String(outcome.rendered.stdout), /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent.stop with pending items on the handoff also yields continue", async () => {
  const root = tempRoot();
  try {
    await coreFacade.handoff.patchHandoff(root, "cursor", { slice: { pending: ["finish the migration"] } });
    const outcome = await runHandler(subagentStopHandler, stdinOf(cursorSubagentStop(root)));
    assert.equal(outcome.decision.kind, "continue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent.stop abstains when the only blocker is the session's own budget/grind cap", async () => {
  const root = tempRoot();
  try {
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: {
        blockers: "Grind cap hit (3 stop loops). Fix manually or pause gates.",
        last_failure_category: "budget",
      },
    });
    const outcome = await runHandler(subagentStopHandler, stdinOf(cursorSubagentStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent.stop still blocks on a budget blocker if other unfinished work is also present", async () => {
  const root = tempRoot();
  try {
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: {
        blockers: "Grind cap hit (3 stop loops). Fix manually or pause gates.",
        last_failure_category: "budget",
        pending: ["finish the migration"],
      },
    });
    const outcome = await runHandler(subagentStopHandler, stdinOf(cursorSubagentStop(root)));
    assert.equal(outcome.decision.kind, "continue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent.stop with no unfinished work abstains under Cursor", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(subagentStopHandler, stdinOf(cursorSubagentStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent.stop with no unfinished work renders no stdout under Claude", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(subagentStopHandler, stdinOf(claudeSubagentStop(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the subagent.stop follow-up names the reporting subagent type", async () => {
  const root = tempRoot();
  try {
    await coreFacade.handoff.patchHandoff(root, "cursor", { slice: { blockers: "still failing lint" } });
    const outcome = await runHandler(
      subagentStopHandler,
      stdinOf(cursorSubagentStop(root, { subagent_type: "explore" })),
    );
    assert.equal(outcome.decision.kind, "continue");
    if (outcome.decision.kind === "continue") {
      assert.match(outcome.decision.text, /explore/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
