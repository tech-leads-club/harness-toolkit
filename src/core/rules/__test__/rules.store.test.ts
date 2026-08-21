import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { buildRuleSet } from "../rules.parse.ts";
import { proofSatisfied } from "../rules.proof.ts";
import {
  globalRulesDir,
  observationsPath,
  projectRulesDir,
  readObservations,
  readRuleSources,
  recordObservation,
} from "../rules.store.ts";

let project: string;
let home: string;
let previousHome: string | undefined;

const RULE = `---
on: pr-open
require:
  - subagent(the-jury) since HEAD
otherwise: deny
---
Convene the jury.`;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "tlc-rules-project-"));
  home = mkdtempSync(join(tmpdir(), "tlc-rules-home-"));
  previousHome = process.env.TLC_HOME;
  process.env.TLC_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = previousHome;
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeRule(dir: string, name: string, text = RULE): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), text, "utf8");
}

describe("readRuleSources", () => {
  /** AC1 — no directory means no rules, which means no behaviour change. */
  test("AC1 absent directories yield no rules and no error", () => {
    assert.deepEqual(readRuleSources(project), []);
  });

  test("AC12 a rule in the global directory is read for a project that has none", () => {
    writeRule(globalRulesDir(), "review-before-pr");

    const sources = readRuleSources(project);

    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.tier, "global");
    assert.equal(sources[0]?.name, "review-before-pr");
  });

  /** invariant: global first, so the project can win by name in `buildRuleSet`. */
  test("AC12 both tiers are read, global before project", () => {
    writeRule(globalRulesDir(), "review-before-pr");
    writeRule(projectRulesDir(project), "review-before-pr");

    const sources = readRuleSources(project);

    assert.deepEqual(
      sources.map((source) => source.tier),
      ["global", "project"],
    );

    const set = buildRuleSet(sources);
    assert.equal(set.rules.length, 1, "one name, one rule");
    assert.equal(set.rules[0]?.tier, "project", "and the nearer tier is the one that applies");
  });

  test("a file that is not markdown is not a rule", () => {
    const dir = projectRulesDir(project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not a rule", "utf8");

    assert.deepEqual(readRuleSources(project), []);
  });
});

describe("observations", () => {
  test("AC5 what is recorded is what satisfies a proof", () => {
    recordObservation(project, {
      kind: "subagent",
      value: "the-jury",
      sha: "abc1234",
      sessionKey: "hostA:sess-1",
      at: "2026-08-21T10:00:00.000Z",
    });

    const observations = readObservations(project);

    assert.equal(observations.length, 1);
    assert.equal(
      proofSatisfied({ kind: "subagent", value: "the-jury", since: "head" }, observations, {
        sha: "abc1234",
        sessionKey: "hostA:sess-1",
      }),
      true,
    );
  });

  test("AC6 no observations means no proof — an empty store satisfies nothing", () => {
    assert.deepEqual(readObservations(project), []);
    assert.equal(
      proofSatisfied({ kind: "subagent", value: "the-jury", since: "head" }, readObservations(project), {
        sha: "abc1234",
        sessionKey: "hostA:sess-1",
      }),
      false,
    );
  });

  /**
   * invariant: append-only, because two sessions observe at the same time and an append is the one write that
   * needs no lock.
   */
  test("two observations from different sessions both survive", () => {
    for (const session of ["hostA:a", "hostA:b"]) {
      recordObservation(project, {
        kind: "gate",
        value: "test",
        sha: "abc1234",
        sessionKey: session,
        at: "2026-08-21T10:00:00.000Z",
      });
    }

    assert.equal(readObservations(project).length, 2);
  });

  /** hazard: an unwritable state directory must not fail the turn that was being observed. */
  test("recording into an unwritable state directory does not throw", () => {
    const blocked = mkdtempSync(join(tmpdir(), "tlc-rules-blocked-"));
    writeFileSync(join(blocked, ".tlc"), "not a directory", "utf8");

    assert.doesNotThrow(() =>
      recordObservation(blocked, {
        kind: "gate",
        value: "test",
        sha: null,
        sessionKey: "hostA:a",
        at: "2026-08-21T10:00:00.000Z",
      }),
    );
    assert.deepEqual(readObservations(blocked), []);
    rmSync(blocked, { recursive: true, force: true });
  });

  /** invariant: the store lives under the project state directory, which the floor refuses to an agent. */
  test("AC6 the observation store is inside the state directory the floor protects", () => {
    assert.match(observationsPath(project), /\.tlc[/\\]harness[/\\]state[/\\]rule-observations\.jsonl$/);
  });
});
