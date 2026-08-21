import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectConfigPath } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";
import { toolBeforeHandler } from "../tool-before.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-tool-before-"));
}

/**
 * hazard: these handlers read the runtime home's `config.json`, so the operator's own settings decided the
 * outcome. Measured: a contributor whose config sets `subagents.enforceAllowlist` with their own model list saw
 * "a Task spawn on an unblocked, allowlisted model is allowed" fail on a healthy tree, because the allowlist under
 * test was theirs and not the default. It passes in CI, where no such file exists — which is the worst version of
 * this: red for the contributor, green for the pipeline ([/decisions/ad-095.md](/decisions/ad-095.md)).
 *
 * invariant: the runtime home is a directory this file owns for the length of its run.
 */
let runtimeSandbox: string;
let previousHome: string | undefined;

before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-tool-before-home-"));
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

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

function writeProjectPolicy(root: string, patch: Record<string, unknown>): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(patch, null, 2), "utf8");
}

function cursorShell(root: string, command: string): string {
  return JSON.stringify({
    hook_event_name: "beforeShellExecution",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    command,
  });
}

function claudeShell(root: string, command: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Bash",
    tool_input: { command },
  });
}

function cursorMcp(root: string): string {
  return JSON.stringify({
    hook_event_name: "beforeMCPExecution",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    tool_name: "mcp__whatever__call",
  });
}

function cursorRead(root: string, filePath: string): string {
  return JSON.stringify({
    hook_event_name: "beforeReadFile",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    file_path: filePath,
  });
}

function cursorTool(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "preToolUse",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    tool_name: "Grep",
    ...overrides,
  });
}

function claudeTool(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "sess-1",
    tool_name: "Grep",
    ...overrides,
  });
}

// invariant: the floor decides before the tunable shell guardrail, so `rm -rf /` is denied outright
// rather than escalated. An ask can be answered yes, and under bypassPermissions it reaches nobody.
for (const [label, build] of [
  ["Claude", claudeShell],
  ["Cursor", cursorShell],
] as const) {
  test(`destruction outside the project is denied by the floor under ${label}`, async () => {
    const root = tempRoot();
    try {
      const outcome = await runHandler(toolBeforeHandler, stdinOf(build(root, "rm -rf /")));
      assert.equal(outcome.decision.kind, "deny");
      assert.match(
        outcome.decision.kind === "deny" ? outcome.decision.reason : "",
        /rule=outside-project-destruction/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a catastrophic command the floor does not cover still reaches the tunable ask", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorShell(root, "diskutil partitionDisk disk2")),
    );
    assert.equal(outcome.decision.kind, "ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a normal shell command is allowed", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(toolBeforeHandler, stdinOf(cursorShell(root, "ls -la")));
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shell command repeated past the stall threshold is denied", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { shell: { stallDetection: true, stallRepeatThreshold: 2 } });
    await runHandler(toolBeforeHandler, stdinOf(cursorShell(root, "npm test")));
    const outcome = await runHandler(toolBeforeHandler, stdinOf(cursorShell(root, "npm test")));
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp.before always allows", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(toolBeforeHandler, stdinOf(cursorMcp(root)));
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read.before denies a credential path and allows an ordinary one", async () => {
  const root = tempRoot();
  try {
    const secret = await runHandler(toolBeforeHandler, stdinOf(cursorRead(root, "~/.ssh/id_rsa")));
    assert.equal(secret.decision.kind, "deny");
    assert.match(secret.decision.kind === "deny" ? secret.decision.reason : "", /rule=secret-access/);

    const ordinary = await runHandler(toolBeforeHandler, stdinOf(cursorRead(root, "src/index.ts")));
    assert.equal(ordinary.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a blocked Task model is denied under Cursor", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Task", tool_input: { model: "worker-fast" } })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a blocked Task model is denied under Claude with the identical reason text as Cursor", async () => {
  const cursorRoot = tempRoot();
  const claudeRoot = tempRoot();
  try {
    const cursorOutcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(cursorRoot, { tool_name: "Task", tool_input: { model: "worker-fast" } })),
    );
    const claudeOutcome = await runHandler(
      toolBeforeHandler,
      stdinOf(claudeTool(claudeRoot, { tool_name: "Task", tool_input: { model: "worker-fast" } })),
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

test("a Task spawn with no model is denied when requireModel is enabled", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { subagents: { requireModel: true } });
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Task", tool_input: {} })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Task spawn with a non-allowlisted model is denied when enforceAllowlist is enabled", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, {
      subagents: { enforceAllowlist: true, allowedModels: ["only-this-one"] },
    });
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Task", tool_input: { model: "something-else" } })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Task spawn's minEffort violation is denied under Claude", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { subagents: { minEffort: "high" } });
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(
        claudeTool(root, {
          tool_name: "Task",
          tool_input: { model: "claude-sonnet-5" },
          effort: { level: "low" },
        }),
      ),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Task spawn's minEffort check is skipped under Cursor, which reports no effort", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { subagents: { minEffort: "high" } });
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Task", tool_input: { model: "composer-2.5" } })),
    );
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Task spawn is denied when the sticky parent state is Fast", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { subagents: { blockParentFast: true } });
    await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Grep", model: "composer-2.5-fast" })),
    );
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Task", tool_input: { model: "composer-2.5" } })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Task spawn on an unblocked, allowlisted model is allowed under Cursor", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Task", tool_input: { model: "composer-2.5" } })),
    );
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Task spawn on an unblocked, allowlisted model is allowed under Claude", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(claudeTool(root, { tool_name: "Task", tool_input: { model: "claude-sonnet-5" } })),
    );
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an Edit to a file held by a live foreign presence yields ask under Claude", async () => {
  const root = tempRoot();
  try {
    coreFacade.presence.register(root, {
      provider: "cursor",
      session: "other-session",
      pid: 1,
      branch: "main",
    });
    coreFacade.presence.heartbeat(root, {
      provider: "cursor",
      session: "other-session",
      file: "src/shared.ts",
    });
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(claudeTool(root, { tool_name: "Edit", tool_input: { file_path: "src/shared.ts" } })),
    );
    assert.equal(outcome.decision.kind, "ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same Edit collision degrades to deny with the escalation prefix under Cursor", async () => {
  const root = tempRoot();
  try {
    coreFacade.presence.register(root, {
      provider: "claude",
      session: "other-session",
      pid: 1,
      branch: "main",
    });
    coreFacade.presence.heartbeat(root, {
      provider: "claude",
      session: "other-session",
      file: "src/shared.ts",
    });
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Edit", tool_input: { file_path: "src/shared.ts" } })),
    );
    assert.equal(outcome.decision.kind, "deny");
    if (outcome.decision.kind === "deny") {
      assert.match(outcome.decision.reason, /^Escalation unavailable on this provider — /);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an Edit with no matching foreign presence is allowed", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Edit", tool_input: { file_path: "src/untouched.ts" } })),
    );
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an Edit where the only matching presence is the current session's own is allowed", async () => {
  const root = tempRoot();
  try {
    coreFacade.presence.register(root, { provider: "cursor", session: "conv-1", pid: 1, branch: "main" });
    coreFacade.presence.heartbeat(root, { provider: "cursor", session: "conv-1", file: "src/shared.ts" });
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Edit", tool_input: { file_path: "src/shared.ts" } })),
    );
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a read-only subagent type attempting Write is denied", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Write", subagent_type: "explore" })),
    );
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a read-only subagent type attempting an allowed tool is allowed", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(cursorTool(root, { tool_name: "Grep", subagent_type: "explore" })),
    );
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shell write to the policy surface is denied by the floor", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(claudeShell(root, "python3 -c \"open('.tlc/harness/config.json','w')\"")),
    );
    assert.equal(outcome.decision.kind, "deny");
    assert.match(
      outcome.decision.kind === "deny" ? outcome.decision.reason : "",
      /rule=policy-surface-write/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mutating harness CLI is denied from inside a session", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "tlc harness pause")));
    assert.equal(outcome.decision.kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// invariant: the integrity check is not policy-gated. This policy switches every tunable rail off and the
// divergence is still refused — otherwise the mutation it detects could switch off its own detector.
test("policy divergence is denied even under a policy with every rail off", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, {
      grind: { enabled: false },
      shipGate: { enabled: false },
      shell: { catastrophicAsk: false, stallDetection: false },
      untrustedContent: { enabled: false },
      planGate: { enabled: false },
      comments: { enabled: false },
      subagents: { enforceAllowlist: false, requireModel: false },
    });
    coreFacade.policy.recordPolicyBaseline(root, "claude-sess-1");
    writeProjectPolicy(root, { grind: { enabled: false }, mode: "solo" });

    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeTool(root)));
    assert.equal(outcome.decision.kind, "deny");
    assert.match(
      outcome.decision.kind === "deny" ? outcome.decision.reason : "",
      /changed during this session/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unchanged policy lets the tool through", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { grind: { enabled: false } });
    coreFacade.policy.recordPolicyBaseline(root, "claude-sess-1");
    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeTool(root)));
    assert.equal(outcome.decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// hazard: `attrs.permission` was read in two places and written in none, so `rollup.shell.ask` was structurally
// zero and the session report printed a truthful-looking `0` for every ask that ever happened. Obs fired only on
// `*.after` events, which made the moment of decision the one moment never recorded.
test("a posture ask is recorded with its permission, posture and rule", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { version: 1, mode: "paired" });
    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "git push origin main")));
    assert.equal(outcome.decision.kind, "ask");

    const events = coreFacade.observability
      .readSignalEvents(root, "obs.jsonl", 50)
      .filter((event) => event.kind === "shell.start");
    assert.equal(events.length, 1, "expected exactly one recorded shell decision");
    const recorded = events[0];
    assert.equal(recorded?.attrs.permission, "ask");
    assert.equal(recorded?.attrs.posture, "paired");
    assert.equal(recorded?.attrs.rule, "shell-posture-paired");
    // invariant: an ask is a signal, never debug — an interruption the operator lived through must survive in
    // the default configuration or the rate is unmeasurable.
    assert.equal(recorded?.level, "signal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: at `paired` a destructive command matches both rules. Attributing it to the posture would read as
// evidence the posture is noisy when the catastrophic switch is what fired.
//
// why this command: the floor denies `rm -rf /` and `sudo reboot` outright, before any policy layer runs, so
// those never reach the shell rule and are recorded by nothing here. `dd` to a raw device is catastrophic to the
// classifier and not a floor rule, which makes it the case that actually exercises the attribution.
test("a catastrophic ask is recorded against the catastrophic rule, not the posture", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { version: 1, mode: "paired" });
    await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "dd if=/dev/zero of=/dev/sda")));
    const recorded = coreFacade.observability
      .readSignalEvents(root, "obs.jsonl", 50)
      .find((event) => event.kind === "shell.start");
    assert.equal(recorded?.attrs.rule, "shell-catastrophic");
    assert.equal(recorded?.attrs.posture, "paired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: an allow grades as debug and `debugEnabled` is false by default, so the common path writes nothing. Were
// it otherwise, connecting this rail would put one append on every shell call the agent makes.
test("an allowed command costs nothing in the default configuration", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { version: 1, mode: "solo" });
    const outcome = await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "ls -la")));
    assert.equal(outcome.decision.kind, "allow");
    assert.equal(
      coreFacade.observability
        .readSignalEvents(root, "obs.jsonl", 50)
        .filter((event) => event.kind === "shell.start").length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// invariant: the counter the report has always printed. It could not move before, because nothing wrote the
// attribute it reads.
test("the rollup's shell ask counter stops being structurally unreachable", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { version: 1, mode: "paired" });
    await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "curl https://example.com")));
    const rollup = coreFacade.observability.getRollup(root, "claude-sess-1");
    assert.equal(rollup?.shell.ask, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// hazard: `policy.deny` fed `rollup.denials` and the report's "Policy denials" line and had no producer, so a
// harness whose whole purpose is refusing things reported zero refusals.
test("a floor denial of a shell command is recorded by the rail that owns shell decisions", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      toolBeforeHandler,
      stdinOf(claudeShell(root, "python3 -c \"open('.tlc/harness/config.json','w')\"")),
    );
    assert.equal(outcome.decision.kind, "deny");

    // invariant: one rail owns every shell decision. The floor short-circuits before that rail runs, so without
    // the explicit hand-off a floor denial of a shell command was recorded by nothing at all.
    const recorded = coreFacade.observability
      .readSignalEvents(root, "obs.jsonl", 50)
      .filter((event) => event.kind === "shell.start");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.attrs.permission, "deny");
    assert.equal(recorded[0]?.attrs.rule, "policy-surface-write");
    assert.equal(coreFacade.observability.getRollup(root, "claude-sess-1")?.shell.deny, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// invariant: the shell rail already records its own decisions with a permission attribute. Recording them again
// through the shared path would double every interruption an operator sees.
test("a shell posture ask is not double-counted as a policy refusal", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { version: 1, mode: "paired" });
    await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "git push origin main")));
    const events = coreFacade.observability.readSignalEvents(root, "obs.jsonl", 50);
    assert.equal(events.filter((event) => event.kind === "shell.start").length, 1);
    assert.equal(events.filter((event) => event.kind === "policy.deny").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an allowed tool call records no refusal", async () => {
  const root = tempRoot();
  try {
    await runHandler(toolBeforeHandler, stdinOf(claudeShell(root, "ls -la")));
    assert.equal(
      coreFacade.observability
        .readSignalEvents(root, "obs.jsonl", 50)
        .filter((event) => event.kind === "policy.deny").length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: the non-shell half of the same rail. A credential read is refused by the floor on `read.before`, which the
// shell rail does not own, so it is the shared refusal path that has to record it.
test("a non-shell refusal is recorded as a policy refusal, carrying the floor rule", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(toolBeforeHandler, stdinOf(cursorRead(root, "~/.ssh/id_rsa")));
    assert.equal(outcome.decision.kind, "deny");

    const refusals = coreFacade.observability
      .readSignalEvents(root, "obs.jsonl", 50)
      .filter((event) => event.kind === "policy.deny");
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]?.attrs.rule, "secret-access");
    assert.equal(refusals[0]?.attrs.permission, "deny");
    assert.equal(coreFacade.observability.getRollup(root, "cursor-conv-1")?.denials, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The operator rules rail, driven through the real entrypoint.
 *
 * why `since session` here and `since HEAD` in the unit tests: the window semantics are decided in
 * `rules.proof.ts` and tested there against a fixed sha, while this asserts the wiring — that a rule read from
 * disk reaches a decision, carries the operator's own text, and stops carrying it once the proof exists
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
describe("operator rules", () => {
  function withRule(root: string, body: string, otherwise = "deny"): void {
    writeProjectPolicy(root, { version: 1, rules: { enabled: true } });
    const dir = join(root, ".tlc", "harness", "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "review-before-pr.md"),
      `---\non: pr-open\nrequire:\n  - subagent(the-jury) since session\notherwise: ${otherwise}\n---\n${body}`,
      "utf8",
    );
  }

  /**
   * hazard: the session key is built by the provider, and the first version of this fixture invented
   * `cursor:conv-1` with a colon. The real one is `cursor-conv-1`, so the proof never matched and the test failed
   * for the wrong reason ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  function observe(root: string, value: string, sessionKey = "cursor-conv-1"): void {
    const dir = join(root, ".tlc", "harness", "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rule-observations.jsonl"),
      `${JSON.stringify({ kind: "subagent", value, sha: null, sessionKey, at: "2026-08-21T10:00:00.000Z" })}\n`,
      "utf8",
    );
  }

  /**
   * hazard: the first version of these tests put the command in `tool_input.command` on a Cursor `preToolUse`
   * payload, and every one of them passed by allowing — because `event.command` comes from the top-level
   * `command` on that host. Measured against 3,755 real records: Claude sends `tool_input.command` on a
   * `PreToolUse` whose `tool_name` is Bash, and Cursor sends a top-level `command` on
   * `beforeShellExecution`. Both shapes are exercised below, or this asserts nothing
   * ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  const OPENING = "npm test && gh pr create --fill";

  function opensPr(root: string, host: "cursor" | "claude", command = OPENING): string {
    return host === "cursor" ? cursorShell(root, command) : claudeShell(root, command);
  }

  test("AC2 a rule with no proof refuses the command and carries the operator's own text", async () => {
    const root = tempRoot();
    try {
      withRule(root, "Convene the jury.\nChecklist: docs/review-checklist.md");

      for (const host of ["cursor", "claude"] as const) {
        const check = await runHandler(toolBeforeHandler, stdinOf(opensPr(root, host)));
        assert.equal(check.decision.kind, "deny", host);
      }

      const outcome = await runHandler(toolBeforeHandler, stdinOf(opensPr(root, "cursor")));
      const reason = outcome.decision.kind === "deny" ? outcome.decision.reason : "";
      assert.match(reason, /rule review-before-pr \(project\)/);
      assert.match(reason, /subagent\(the-jury\) since session/);
      assert.match(reason, /Convene the jury\./, "the body is verbatim");
      assert.match(reason, /docs\/review-checklist\.md/, "including the attachment");
      assert.equal(outcome.decision.kind === "deny" ? outcome.decision.rule : "", "rule:review-before-pr");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AC3 the same command is allowed once the proof exists", async () => {
    const root = tempRoot();
    try {
      withRule(root, "Convene the jury.");
      observe(root, "the-jury");

      const outcome = await runHandler(toolBeforeHandler, stdinOf(opensPr(root, "cursor")));

      assert.equal(outcome.decision.kind, "allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** invariant: another subagent having run is not this proof. */
  test("AC5 an observation of a different subagent does not satisfy the rule", async () => {
    const root = tempRoot();
    try {
      withRule(root, "Convene the jury.");
      observe(root, "explore");

      const outcome = await runHandler(toolBeforeHandler, stdinOf(opensPr(root, "cursor")));

      assert.equal(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a command the rule does not name is untouched", async () => {
    const root = tempRoot();
    try {
      withRule(root, "Convene the jury.");

      const outcome = await runHandler(toolBeforeHandler, stdinOf(opensPr(root, "cursor", "npm test")));

      assert.equal(outcome.decision.kind, "allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** AC1 — the capability off means the rule file is inert, not read-and-ignored. */
  test("AC1 with rules.enabled false the rule does not fire", async () => {
    const root = tempRoot();
    try {
      withRule(root, "Convene the jury.");
      writeProjectPolicy(root, { version: 1, rules: { enabled: false } });

      const outcome = await runHandler(toolBeforeHandler, stdinOf(opensPr(root, "cursor")));

      assert.equal(outcome.decision.kind, "allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** AC1 — and with no rule files at all, nothing changes for anybody. */
  test("AC1 no rules directory changes nothing", async () => {
    const root = tempRoot();
    try {
      writeProjectPolicy(root, { version: 1, rules: { enabled: true } });

      const outcome = await runHandler(toolBeforeHandler, stdinOf(opensPr(root, "cursor")));

      assert.equal(outcome.decision.kind, "allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** AC8 — warn never blocks the action. */
  test("AC8 a warn rule allows the command", async () => {
    const root = tempRoot();
    try {
      withRule(root, "Convene the jury.", "warn");

      const outcome = await runHandler(toolBeforeHandler, stdinOf(opensPr(root, "cursor")));

      assert.equal(outcome.decision.kind, "allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * AC13 — this host cannot ask, so `ask` degrades to deny for that reason too. The posture rule is asserted in
   * `rules.decide.test.ts`; what matters here is that an `ask` rule still refuses rather than passing.
   */
  test("AC13 an ask rule does not let the command through on a host that cannot ask", async () => {
    const root = tempRoot();
    try {
      withRule(root, "Convene the jury.", "ask");

      const outcome = await runHandler(toolBeforeHandler, stdinOf(opensPr(root, "cursor")));

      assert.equal(outcome.decision.kind, "deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
