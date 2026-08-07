import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { HarnessLesson } from "../../core/index.ts";
import { coreFacade } from "../../core/index.ts";
import { policyBaselineDir, presenceDir, projectConfigPath } from "../../platform/paths.ts";
import { CONTEXT_BUDGET_CHARS, runHandler } from "../run.ts";
import { sessionEndHandler } from "../session-end.ts";
import { sessionStartHandler } from "../session-start.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-session-"));
}

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

function writeProjectPolicy(root: string, patch: Record<string, unknown>): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(patch, null, 2), "utf8");
}

function cursorStart(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "sessionStart",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    ...overrides,
  });
}

function claudeStart(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "SessionStart",
    cwd: root,
    session_id: "sess-1",
    ...overrides,
  });
}

function cursorEnd(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "sessionEnd",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    ...overrides,
  });
}

function claudeEnd(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "SessionEnd",
    cwd: root,
    session_id: "sess-1",
    ...overrides,
  });
}

function lesson(overrides: Partial<HarnessLesson> & Pick<HarnessLesson, "id">): HarnessLesson {
  const now = "2026-07-27T00:00:00.000Z";
  return {
    scope: "gate-execution",
    failedGate: "test",
    category: "test",
    triggerTokens: ["test"],
    instruction: "fix it",
    avoid: "do not guess",
    prefer: "read the assertion",
    preRetryCheck: "check the failing test",
    source: "project",
    status: "candidate",
    confidence: 0.5,
    hitCount: 1,
    priority: 50,
    tier: "project",
    pinned: false,
    refs: [],
    sessionKeys: [],
    injectedCount: 0,
    gradeableCount: 0,
    helpedCount: 0,
    neutralCount: 0,
    firstSeenAt: now,
    lastSeenAt: now,
    lastAccessedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("session.start under Cursor renders env.HARNESS_ACTIVE", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    assert.match(String(outcome.rendered.stdout), /"env":\{"HARNESS_ACTIVE":"1"\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.start under Claude does not render an env key", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(sessionStartHandler, stdinOf(claudeStart(root)));
    assert.ok(!String(outcome.rendered.stdout).includes("HARNESS_ACTIVE"));
    assert.match(String(outcome.rendered.stdout), /"hookSpecificOutput"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.start bootstrap context includes a foreign slice labelled with its provider under Cursor", async () => {
  const root = tempRoot();
  try {
    await coreFacade.handoff.patchHandoff(root, "claude", {
      slice: { next_action: "finish the migration", blockers: "waiting on review" },
    });
    const outcome = await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.match(outcome.decision.text, /Foreign slice \(claude\)/);
      assert.match(outcome.decision.text, /finish the migration/);
      assert.match(outcome.decision.text, /waiting on review/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.start bootstrap context includes a foreign slice labelled with its provider under Claude", async () => {
  const root = tempRoot();
  try {
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: { next_action: "review the PR" },
    });
    const outcome = await runHandler(sessionStartHandler, stdinOf(claudeStart(root)));
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.match(outcome.decision.text, /Foreign slice \(cursor\)/);
      assert.match(outcome.decision.text, /review the PR/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a first session.start performs the full bootstrap with non-empty context", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.ok(outcome.decision.text.length > 0);
      assert.match(outcome.decision.text, /Project root:/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second session.start for the same sessionKey is idempotent and skips re-bootstrapping", async () => {
  const root = tempRoot();
  try {
    await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    const second = await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    assert.equal(second.decision.kind, "context");
    if (second.decision.kind === "context") {
      assert.equal(second.decision.text, "");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.start records the policy baseline, so a mid-session change is detectable", async () => {
  const root = tempRoot();
  try {
    mkdirSync(dirname(projectConfigPath(root)), { recursive: true });
    writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1 }), "utf8");
    await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));

    assert.ok(existsSync(policyBaselineDir(root)), "no baseline directory was written");
    const [recorded] = readdirSync(policyBaselineDir(root));
    assert.ok(recorded, "no baseline file was written for the session");

    // why: the baseline only earns its place if a later change is caught. Asserting the file exists would
    // pass on an empty fingerprint.
    writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1, mode: "solo" }), "utf8");
    const sessionKey = (recorded as string).replace(/\.json$/, "");
    assert.equal(coreFacade.policy.checkPolicyBaseline(root, sessionKey).kind, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.start registers a presence record", async () => {
  const root = tempRoot();
  try {
    await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    const { readPresenceRecord } = await import("../../core/presence/presence.service.ts");
    const presence = readPresenceRecord(root, "cursor", "conv-1");
    assert.ok(presence);
    assert.equal(presence?.provider, "cursor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.start sweeps stale presence records", async () => {
  const root = tempRoot();
  try {
    coreFacade.presence.register(root, {
      provider: "claude",
      session: "old-session",
      pid: 1,
      branch: "main",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    const { readPresenceRecord } = await import("../../core/presence/presence.service.ts");
    assert.equal(readPresenceRecord(root, "claude", "old-session"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.end deletes the presence record for its session", async () => {
  const root = tempRoot();
  try {
    coreFacade.presence.register(root, { provider: "cursor", session: "conv-1", pid: 1, branch: "main" });
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    const { readPresenceRecord } = await import("../../core/presence/presence.service.ts");
    assert.equal(readPresenceRecord(root, "cursor", "conv-1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.end resets the loop counter for its session", async () => {
  const root = tempRoot();
  try {
    coreFacade.turn.nextLoop(root, "cursor-conv-1");
    coreFacade.turn.nextLoop(root, "cursor-conv-1");
    assert.equal(coreFacade.turn.currentLoopCount(root, "cursor-conv-1"), 2);
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    assert.equal(coreFacade.turn.currentLoopCount(root, "cursor-conv-1"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("injected bootstrap context over the context budget is truncated with the marker", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { intelligence: { lessons: { maxCharsSession: 200 } } });
    for (let i = 0; i < 120; i++) {
      await coreFacade.handoff.patchHandoff(root, `foreign-${i}`, {
        slice: { next_action: "x".repeat(100), blockers: "y".repeat(100) },
      });
    }
    const outcome = await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.ok(outcome.decision.text.length <= CONTEXT_BUDGET_CHARS);
      assert.ok(outcome.decision.text.length > 200, "the lessons budget must not cap the whole context");
      assert.match(outcome.decision.text, /truncated — over context budget/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.end awaits lesson gardening before returning — a candidate is promoted synchronously", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, {
      intelligence: { lessons: { enabled: true, gardenOnSessionEnd: true, promoteHitCount: 1 } },
    });
    await coreFacade.lesson.upsertProjectLesson(
      root,
      lesson({ id: "project:test:promote-me", status: "candidate", hitCount: 5 }),
    );
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    const stored = coreFacade.lesson.readProjectLessons(root);
    const promoted = stored.find((item) => item.id === "project:test:promote-me");
    assert.equal(promoted?.status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.end triggers the Cursor-native lessons view through the provider", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, {
      intelligence: { lessons: { enabled: true, gardenOnSessionEnd: true, syncRulesFile: true } },
    });
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    assert.ok(existsSync(join(root, ".cursor", "rules", "harness-lessons.mdc")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: the session-end write is a second call site, and it rendered from `readProjectLessons` while the CLI
 * rendered from all three tiers. A sensor caught it: emptying the list there left every test green, because the only
 * assertion on the file's content ran against the session-start path ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("the view written at session end carries the core tier too", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, {
      intelligence: { lessons: { enabled: true, gardenOnSessionEnd: true, syncRulesFile: "always" } },
    });
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    const body = readFileSync(join(root, ".cursor", "rules", "harness-lessons.mdc"), "utf8");
    assert.match(body, /\/core\]/, "a shipped core lesson reaches the file written at session end");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.end triggers the Claude-native lessons view through the provider", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, {
      intelligence: { lessons: { enabled: true, gardenOnSessionEnd: true, syncRulesFile: true } },
    });
    await runHandler(sessionEndHandler, stdinOf(claudeEnd(root)));
    const claudeMd = join(root, "CLAUDE.md");
    assert.ok(existsSync(claudeMd));
    assert.match(readFileSync(claudeMd, "utf8"), /@\.tlc\/harness\/lessons\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.end does not write the provider lessons view when syncRulesFile is disabled", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, {
      intelligence: { lessons: { enabled: true, gardenOnSessionEnd: true, syncRulesFile: "never" } },
    });
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    assert.ok(!existsSync(join(root, ".cursor", "rules", "harness-lessons.mdc")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: the durable view was written only at session end, so on the host that depends on it the file held the
 * previous session's set and did not exist during the first session at all — the transport was always one session
 * behind the lessons it was carrying ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("a Cursor session start puts the durable view in place before the first prompt", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { intelligence: { lessons: { enabled: true } } });
    await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    const view = join(root, ".cursor", "rules", "harness-lessons.mdc");
    assert.ok(existsSync(view), "the rules file exists after the first session start");
    assert.match(readFileSync(view, "utf8"), /alwaysApply: true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: the view rendered from `readProjectLessons`, so it carried one of the three tiers. On the host where it is
 * the only route to the model, every shipped core lesson and every global lesson reached nothing
 * ([/decisions/ad-040.md](/decisions/ad-040.md)).
 */
test("the durable view carries the core tier, not only this project's lessons", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { intelligence: { lessons: { enabled: true } } });
    await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    const body = readFileSync(join(root, ".cursor", "rules", "harness-lessons.mdc"), "utf8");
    assert.match(body, /\/core\]/, "a shipped core lesson reaches the file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: a sensor caught this one. Zeroing `durable_chars` at the producer left the whole suite green — the report
 * read a field nothing asserted, which is the shape of every dead rail this project has found
 * ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("session start records the durable view's size and what the host does with hook context", () => {
  const root = tempRoot();
  return (async () => {
    try {
      writeProjectPolicy(root, { intelligence: { lessons: { enabled: true } } });
      await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
      const rollup = coreFacade.observability.getRollup(root, "cursor-conv-1");
      assert.ok(rollup, "a rollup was written");
      assert.equal(rollup?.hook_context_reliable, false, "this host declares it drops hook context");
      assert.ok(
        (rollup?.durable_chars ?? 0) > 0,
        `the durable view's size reached the rollup, got ${rollup?.durable_chars}`,
      );
      assert.ok((rollup?.injected_chars ?? 0) > 0, "the emission is still counted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  })();
});

// invariant: the control. A host that delivers hook context gets no file written at session start either.
test("a Claude session start writes no durable view", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { intelligence: { lessons: { enabled: true } } });
    await runHandler(sessionStartHandler, stdinOf(claudeStart(root)));
    assert.ok(!existsSync(join(root, "CLAUDE.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: this is the reported defect. An operator ran an all-defaults init on Cursor, switched lessons on, and the
 * lessons reached the model by no route at all — the hook drops the text on that host and the durable view was off
 * by default ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("a Cursor session with lessons on and no sync setting still gets the durable view", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { intelligence: { lessons: { enabled: true, gardenOnSessionEnd: true } } });
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    assert.ok(existsSync(join(root, ".cursor", "rules", "harness-lessons.mdc")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * invariant: the control for the test above. On a host that delivers hook context there is nothing to fall back to,
 * so `auto` writes nothing — otherwise "auto" would just mean "always" and the capability would be decoration.
 */
test("a Claude session with lessons on and no sync setting writes no durable view", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { intelligence: { lessons: { enabled: true, gardenOnSessionEnd: true } } });
    await runHandler(sessionEndHandler, stdinOf(claudeEnd(root)));
    assert.ok(!existsSync(join(root, "CLAUDE.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// invariant: a config written before the mode existed keeps working — `true` still writes the view.
test("the legacy boolean true still writes the Cursor view", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, {
      intelligence: { lessons: { enabled: true, gardenOnSessionEnd: true, syncRulesFile: true } },
    });
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    assert.ok(existsSync(join(root, ".cursor", "rules", "harness-lessons.mdc")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// invariant: and `false` still withholds it, rather than falling through to the new default.
test("the legacy boolean false still withholds the Cursor view", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, {
      intelligence: { lessons: { enabled: true, gardenOnSessionEnd: true, syncRulesFile: false } },
    });
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    assert.ok(!existsSync(join(root, ".cursor", "rules", "harness-lessons.mdc")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.end returns an abstain decision under Cursor", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.end renders no stdout and exit 0 under Claude", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(sessionEndHandler, stdinOf(claudeEnd(root)));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, null);
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * invariant: the pointer names the command, never the file. The path is on the policy surface, so an instruction to
 * read it asked for something the floor refuses — a colleague's agent followed the instruction and was blocked
 * ([/decisions/ad-047.md](/decisions/ad-047.md)).
 */
test("session.start points at the sanctioned command, not at the protected path", async () => {
  const root = tempRoot();
  try {
    await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    const handoff = coreFacade.handoff.readHandoff(root, "cursor");
    assert.match(String(handoff.next_action), /tlc harness handoff/);
    assert.doesNotMatch(String(handoff.next_action), /\.tlc\/harness\/state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.end patches the handoff next_action to point at resuming", async () => {
  const root = tempRoot();
  try {
    await runHandler(sessionEndHandler, stdinOf(cursorEnd(root)));
    const handoff = coreFacade.handoff.readHandoff(root, "cursor");
    assert.match(String(handoff.next_action), /Session ended/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.start under Claude completes without throwing when there is no prior handoff or lessons", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(sessionStartHandler, stdinOf(claudeStart(root)));
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("presence directory holds exactly one record after a session.start", async () => {
  const root = tempRoot();
  try {
    await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    const { readdirSync } = await import("node:fs");
    assert.equal(readdirSync(presenceDir(root)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session.start carries the gaps the previous session ended with", async () => {
  const root = tempRoot();
  try {
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: {
        previous_gaps: [
          { id: "test-0", gate: "test", category: "verification", summary: "auth.spec.ts expected 200" },
        ],
      },
    });
    const outcome = await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.match(outcome.decision.text, /Gaps open when the previous session ended/);
      assert.match(outcome.decision.text, /\[test\/verification\] auth\.spec\.ts expected 200/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("progressiveHandoff off withholds the carried gaps", async () => {
  const root = tempRoot();
  try {
    writeProjectPolicy(root, { intelligence: { progressiveHandoff: false } });
    await coreFacade.handoff.patchHandoff(root, "cursor", {
      slice: {
        previous_gaps: [
          { id: "test-0", gate: "test", category: "verification", summary: "auth.spec.ts expected 200" },
        ],
      },
    });
    const outcome = await runHandler(sessionStartHandler, stdinOf(cursorStart(root)));
    assert.equal(outcome.decision.kind, "context");
    if (outcome.decision.kind === "context") {
      assert.ok(!outcome.decision.text.includes("Gaps open when the previous session ended"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("carried gaps past the limit are counted rather than dropped in silence", () => {
  const gaps = Array.from({ length: 8 }, (_, index) => ({
    id: `test-${index}`,
    gate: "test",
    category: "verification" as const,
    summary: `failure ${index}`,
  }));
  const rendered = coreFacade.turn.formatCarriedGaps(gaps);
  assert.match(rendered, /failure 4/);
  assert.ok(!rendered.includes("failure 5"));
  assert.match(rendered, /\(3 more not shown/);
});

test("no carried gaps renders nothing at all", () => {
  assert.equal(coreFacade.turn.formatCarriedGaps([]), "");
});
