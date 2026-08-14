import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTHORED_GATE, authoredLessonId, buildAuthoredLesson } from "../lesson.authored.ts";

const NOW = "2026-08-04T12:00:00.000Z";

// why: the store had exactly one producer — gate stagnation — so a lesson learned by reasoning had no way in, while
// the mechanism that would carry it already ran every session ([/decisions/ad-035.md](/decisions/ad-035.md)).
test("an authored lesson is marked manual, the source the union already anticipated", () => {
  const lesson = buildAuthoredLesson({ instruction: "Do the thing.", now: NOW });
  assert.equal(lesson.source, "manual");
  assert.equal(lesson.instruction, "Do the thing.");
});

// why: active, not candidate. A candidate exists because the automatic producer is guessing from output; an author is
// not, and a promotion threshold only recurrence can satisfy would mean an authored lesson never activates.
test("an authored lesson is active immediately", () => {
  assert.equal(buildAuthoredLesson({ instruction: "x", now: NOW }).status, "active");
});

// why: a real gate name would falsely boost a retry for that gate. Session-mode injection carries it regardless.
test("with no gate given it takes a neutral gate rather than inventing one", () => {
  assert.equal(buildAuthoredLesson({ instruction: "x", now: NOW }).failedGate, AUTHORED_GATE);
  assert.equal(buildAuthoredLesson({ instruction: "x", gate: "test", now: NOW }).failedGate, "test");
});

// why: writing the same lesson twice should update it, not fill the store with near-duplicates.
test("the id is stable across whitespace and case, so a rewrite updates in place", () => {
  assert.equal(authoredLessonId("Do the Thing."), authoredLessonId("  do the thing.  "));
  assert.notEqual(authoredLessonId("Do the thing."), authoredLessonId("Do another thing."));
});

// why: recorded rather than refused. An agent that cannot write down what it learned writes nothing down — which is
// the state this replaces — so the marking is what keeps it auditable.
test("a lesson authored inside an agent session says so in its category", () => {
  assert.equal(
    buildAuthoredLesson({ instruction: "x", inAgentSession: true, now: NOW }).category,
    "authored-in-session",
  );
  assert.equal(
    buildAuthoredLesson({ instruction: "x", inAgentSession: false, now: NOW }).category,
    "authored",
  );
});

test("trigger tokens are normalised, and empty ones dropped", () => {
  const lesson = buildAuthoredLesson({
    instruction: "x",
    triggerTokens: [" Producer ", "", "ZERO"],
    now: NOW,
  });
  assert.deepEqual(lesson.triggerTokens, ["producer", "zero"]);
});

test("the optional halves default to empty rather than to invented text", () => {
  const lesson = buildAuthoredLesson({ instruction: "x", now: NOW });
  assert.equal(lesson.avoid, "");
  assert.equal(lesson.prefer, "");
  assert.equal(lesson.preRetryCheck, "");
});

// invariant: the decay clock starts now, so an authored lesson ages by recurrence like any other ([/decisions/ad-023.md](/decisions/ad-023.md)).
test("the decay fields all start at the given time", () => {
  const lesson = buildAuthoredLesson({ instruction: "x", now: NOW });
  assert.equal(lesson.firstSeenAt, NOW);
  assert.equal(lesson.lastSeenAt, NOW);
  assert.equal(lesson.lastAccessedAt, NOW);
});

// invariant: this module knows nothing about where a lesson came from in the world — no document layout, no
// decision-record convention, no directory. The harness ships the mechanism; a project decides what feeds it.
test("the input carries no notion of a file, a doc or a repository layout", () => {
  const lesson = buildAuthoredLesson({ instruction: "x", now: NOW });
  for (const coupling of ["path", "file", "doc", "decision", "adr"]) {
    assert.equal(
      Object.keys(lesson).some((key) => key.toLowerCase().includes(coupling)),
      false,
      coupling,
    );
  }
});
