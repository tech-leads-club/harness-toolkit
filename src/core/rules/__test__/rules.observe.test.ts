import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gateObservation, observationFrom } from "../rules.observe.ts";

const CONTEXT = { sha: "abc1234", sessionKey: "hostA:sess-1", at: "2026-08-21T10:00:00.000Z" };

describe("observationFrom", () => {
  test("AC5 a subagent stopping is proof that that subagent ran", () => {
    const observation = observationFrom({ event: "subagent.stop", spawnSubagentType: "the-jury" }, CONTEXT);

    assert.deepEqual(observation, {
      kind: "subagent",
      value: "the-jury",
      sha: "abc1234",
      sessionKey: "hostA:sess-1",
      at: "2026-08-21T10:00:00.000Z",
    });
  });

  /** why the type: a rule says "the jury reviewed", not "agent 7f3a reviewed". */
  test("a subagent stopping with no type proves nothing", () => {
    assert.equal(observationFrom({ event: "subagent.stop" }, CONTEXT), null);
  });

  /**
   * AC5 — measured: `shell.after` carries no exit code in any host shape, and a tool that fails arrives as
   * `tool.failure`. So this event already means the command ran and did not fail
   * ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  test("AC5 a command that completed is proof it ran", () => {
    for (const event of ["tool.after", "shell.after"]) {
      const observation = observationFrom({ event, command: "gh pr review 42 --approve" }, CONTEXT);
      assert.equal(observation?.kind, "command", event);
      assert.equal(observation?.value, "gh pr review 42 --approve", event);
    }
  });

  /** invariant: failure is a different event, and it proves nothing. This is the whole reason no exit code is needed. */
  test("AC5 a command that failed is not proof", () => {
    assert.equal(observationFrom({ event: "tool.failure", command: "gh pr review" }, CONTEXT), null);
  });

  test("AC5 a completed edit is proof that file changed", () => {
    const observation = observationFrom({ event: "edit.after", filePath: "docs/review.md" }, CONTEXT);

    assert.equal(observation?.kind, "file");
    assert.equal(observation?.value, "docs/review.md");
  });

  /** invariant: one event, one observation. A command's path argument is not a file the turn wrote. */
  test("a tool.after carrying both a command and a path is a command", () => {
    const observation = observationFrom(
      { event: "tool.after", command: "cat docs/review.md", filePath: "docs/review.md" },
      CONTEXT,
    );

    assert.equal(observation?.kind, "command");
  });

  test("events that prove nothing yield nothing", () => {
    for (const event of ["tool.before", "stop", "session.start", "read.before", "prompt.submit"]) {
      assert.equal(observationFrom({ event, command: "x", filePath: "y" }, CONTEXT), null, event);
    }
  });

  /** invariant: the sha travels with the observation, because freshness is part of the proof. */
  test("AC4 the observation carries the sha it was made against, including none", () => {
    assert.equal(
      observationFrom({ event: "subagent.stop", spawnSubagentType: "x" }, CONTEXT)?.sha,
      "abc1234",
    );
    assert.equal(
      observationFrom({ event: "subagent.stop", spawnSubagentType: "x" }, { ...CONTEXT, sha: null })?.sha,
      null,
    );
  });
});

describe("gateObservation", () => {
  /** why separate: a gate outcome is not an event a host sends. The harness decides it, so it records it. */
  test("AC5 a gate outcome is recorded with the gate's own name", () => {
    assert.deepEqual(gateObservation("test", CONTEXT), {
      kind: "gate",
      value: "test",
      sha: "abc1234",
      sessionKey: "hostA:sess-1",
      at: "2026-08-21T10:00:00.000Z",
    });
  });
});
