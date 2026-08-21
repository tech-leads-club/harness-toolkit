import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { HarnessLesson } from "../../src/core/lesson/lesson.types.ts";
import { DEFAULTS } from "../../src/core/policy/policy.defaults.ts";
import { flagValue, gardenText, lessonRows, listReport, listText, positionalWords } from "../lessons-cli.ts";

const cleanupRoots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-lessons-cli-"));
  cleanupRoots.push(root);
  return root;
}

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const CONFIG = DEFAULTS.intelligence.lessons;
const NOW = new Date("2026-07-30T12:00:00.000Z");

function lesson(overrides: Partial<HarnessLesson> = {}): HarnessLesson {
  return {
    id: "lesson-1",
    scope: "gate-execution",
    failedGate: "lint",
    category: "verification",
    triggerTokens: ["lint", "biome"],
    instruction: "Do not retry the same failing patch.",
    avoid: "Re-applying the same edit.",
    prefer: "Diagnose the root cause on a different path.",
    preRetryCheck: "Diff the last edit against the gate output.",
    source: "project",
    status: "active",
    confidence: 0.8,
    hitCount: 2,
    priority: 1,
    tier: "project",
    pinned: false,
    refs: [],
    sessionKeys: [],
    injectedCount: 0,
    gradeableCount: 0,
    helpedCount: 0,
    neutralCount: 0,
    firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    lastAccessedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("lessonRows", () => {
  test("projects the fields the text renderer prints, plus a computed score", () => {
    const rows = lessonRows(newRoot(), [lesson()], CONFIG, NOW);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.id, "lesson-1");
    assert.equal(row?.gate, "lint");
    assert.equal(row?.hits, 2);
    assert.equal(row?.source, "project");
    assert.equal(typeof row?.score, "number");
  });

  test("an empty store projects to an empty list, not to a placeholder row", () => {
    assert.deepEqual(lessonRows(newRoot(), [], CONFIG, NOW), []);
  });
});

describe("listReport", () => {
  test("carries the count, the store path and the three config facts", () => {
    const root = newRoot();
    const report = listReport(root, [lesson(), lesson({ id: "lesson-2" })], CONFIG, NOW);
    assert.equal(report.count, 2);
    assert.ok(report.storePath.startsWith(root));
    assert.deepEqual(report.config, {
      enabled: CONFIG.enabled,
      promoteHitCount: CONFIG.promoteHitCount,
      syncRulesFile: CONFIG.syncRulesFile,
    });
  });

  test("survives a JSON round trip", () => {
    const report = listReport(newRoot(), [lesson()], CONFIG, NOW);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  });
});

describe("listText", () => {
  // invariant: the human view is rendered from the same projection the flag emits, so the two can never
  // report different counts or a different store path.
  test("renders from the report, naming the count and the store path", () => {
    const root = newRoot();
    const report = listReport(root, [lesson()], CONFIG, NOW);
    const text = listText(report);
    assert.match(text, /1 lesson —/);
    assert.ok(text.includes(report.storePath));
    assert.match(text, /gate=lint tier=project hits=2 sessions=0 src=project/);
  });

  test("an empty store still reports the count and the config line", () => {
    const text = listText(listReport(newRoot(), [], CONFIG, NOW));
    assert.match(text, /0 lessons —/);
    assert.match(text, /promoteHitCount=/);
  });

  // why: the operator has to be able to tell a withheld lesson from a listed one, or the list contradicts what
  // the turn actually received.
  test("a withheld lesson is marked, and a healthy one is not", () => {
    const root = newRoot();
    const stale = listText(listReport(root, [lesson({ staleReason: "path-missing" })], CONFIG, NOW));
    assert.match(stale, /WITHHELD/);
    assert.match(stale, /stale=path-missing/);
    assert.doesNotMatch(listText(listReport(root, [lesson()], CONFIG, NOW)), /WITHHELD/);
  });

  // invariant: unproven is reported as its own state, never folded into a zero rate.
  test("a lesson nothing has graded reads unproven rather than zero", () => {
    const text = listText(
      listReport(newRoot(), [lesson({ injectedCount: 2, gradeableCount: 2 })], CONFIG, NOW),
    );
    assert.match(text, /effect=unproven \(injected for a gate 2x, graded 0x\)/);
    assert.match(text, /unproven=1/);
  });

  /**
   * hazard: `byTier` reports the resolved set, so a promoted lesson — present in both stores — counts as `project`
   * and the global tier reads as empty. An operator seeing `core=6 project=5` concludes `promote` did nothing.
   */
  test("the store counts make a promoted lesson visible even though the tier count hides it", () => {
    const report = listReport(newRoot(), [lesson()], CONFIG, NOW);
    assert.equal(typeof report.stores.project, "number");
    assert.equal(typeof report.stores.global, "number");
    assert.equal(typeof report.stores.shared, "number");
    const text = listText(report);
    assert.match(text, /project store: .*\(0 lessons\)/);
    assert.match(text, /global store: .*\(0 lessons\)/);
    assert.doesNotMatch(text, /also in this project/, "the shared note is silent when nothing is shared");
  });

  test("the totals name each tier and both store paths", () => {
    const report = listReport(newRoot(), [lesson()], CONFIG, NOW);
    const text = listText(report);
    assert.deepEqual(report.totals.byTier, { project: 1 });
    assert.match(text, /project=1/);
    assert.ok(text.includes(report.globalStorePath));
  });

  // hazard: a lesson nothing has shown yet was counted as unproven, so a fresh store reported every lesson as an
  // unjustified claim — a number nobody can act on.
  test("a lesson that was never injected is counted apart from an unproven one", () => {
    const report = listReport(
      newRoot(),
      [lesson(), lesson({ id: "lesson-2", injectedCount: 4, gradeableCount: 4 })],
      CONFIG,
      NOW,
    );
    assert.equal(report.totals.notInjected, 1);
    assert.equal(report.totals.unproven, 1);
    const text = listText(report);
    assert.match(text, /effect=not-injected/);
    assert.match(text, /unproven=1 not-injected=1/);
  });

  // hazard: `sessions` came from the promotion helper, which falls back to `hitCount` for a record with no session
  // keys — so an authored lesson that never had a session reported `sessions=1`.
  test("sessions counts real session keys and never falls back to hitCount", () => {
    const rows = lessonRows(newRoot(), [lesson({ hitCount: 9, sessionKeys: [] })], CONFIG, NOW);
    assert.equal(rows[0]?.sessions, 0);
    assert.equal(rows[0]?.hits, 9);
  });
});

// why: the report used to be printed as raw JSON, so `"stale": ["manual:f70cc…"]` told the operator an id and not
// what happened to it ([/decisions/ad-034.md](/decisions/ad-034.md)).
describe("gardenText", () => {
  const empty = {
    promoted: [],
    quarantined: [],
    pruned: [],
    stale: [],
    refreshed: [],
    expired: [],
    active: 0,
    candidates: 0,
  };

  test("each change says what it means from now on", () => {
    const text = gardenText({ ...empty, stale: ["a"], expired: ["b"], promoted: ["c"], active: 3 });
    assert.match(text, /now withheld — a named path or symbol no longer resolves: a/);
    assert.match(text, /pruned — past its validity window: b/);
    assert.match(text, /promoted to active .*: c/);
    assert.match(text, /3 active/);
  });

  test("a no-op run says so rather than printing empty lists", () => {
    const text = gardenText(empty);
    assert.match(text, /nothing changed/);
    assert.doesNotMatch(text, /\[\]/);
  });

  test("a cleared staleness is reported as a recovery, not as a new problem", () => {
    assert.match(gardenText({ ...empty, refreshed: ["a"] }), /no longer withheld/);
  });
});

test("flagValue reads the value after a flag and stops at the next flag", () => {
  assert.equal(flagValue(["add", "x", "--gate", "test"], "--gate"), "test");
  assert.equal(flagValue(["add", "x", "--gate", "--avoid"], "--gate"), undefined);
  assert.equal(flagValue(["add", "x"], "--gate"), undefined);
});

// why: the instruction is everything before the first flag, so `add "a b c" --gate test` reads naturally without
// shell quoting gymnastics.
test("positionalWords takes everything before the first flag", () => {
  assert.equal(positionalWords(["do", "the", "thing", "--gate", "test"]), "do the thing");
  assert.equal(positionalWords(["--gate", "test"]), "");
});

/**
 * hazard: the list cut the instruction at 160 characters with no marker, so a 263-character lesson lost 103 of
 * them mid-word and an operator asked why their lesson had been cut — it had not been, only its display had. The
 * slice is gone; the section is wrapped instead ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
test("a long instruction reaches the screen whole", () => {
  const instruction = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
  assert.ok(instruction.length > 160, "the fixture has to be longer than the old slice");

  const text = listText(listReport(newRoot(), [lesson({ instruction })], CONFIG, NOW));
  const shown = text
    .split("\n")
    .map((line) => line.trim())
    .join(" ");

  for (const word of instruction.split(" ")) {
    assert.ok(shown.includes(word), `${word} is missing from the screen`);
  }
});
