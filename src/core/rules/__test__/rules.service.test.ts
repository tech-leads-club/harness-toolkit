import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { decideAction, loadRules, observe } from "../rules.service.ts";
import { globalRulesDir, observationsPath, projectRulesDir } from "../rules.store.ts";

let project: string;
let home: string;
let previousHome: string | undefined;

const OFF = { enabled: false };
const ON = { enabled: true };

const RULE = `---
on: pr-open
require:
  - subagent(the-jury) since HEAD
otherwise: deny
---
Convene the jury.`;

const PR_OPEN = { event: "shell.before" as const, command: "gh pr create --fill" };
const CONTEXT = { sha: "abc1234", sessionKey: "hostA:sess-1", mode: "solo" as const, shaRoot: "/repo" };
const SEEN = { sha: "abc1234", sessionKey: "hostA:sess-1", at: "2026-08-21T10:00:00.000Z" };
const JURY_STOPPED = { event: "subagent.stop", spawnSubagentType: "the-jury" };

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "tlc-rules-svc-project-"));
  home = mkdtempSync(join(tmpdir(), "tlc-rules-svc-home-"));
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

/**
 * AC1 — this is the single owner of the capability switch. Every caller reaches the feature through here, so a
 * copy of this condition anywhere else is a second thing to keep true
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
describe("the capability switch", () => {
  test("AC1 a declared rule is invisible while the capability is off", () => {
    writeRule(projectRulesDir(project), "review-before-pr");

    assert.deepEqual(loadRules(project, OFF), { rules: [], disabled: [], errors: [] });
    assert.equal(loadRules(project, ON).rules.length, 1, "and visible the moment it is switched on");
  });

  test("AC1 a global rule is invisible too — the switch is not per tier", () => {
    writeRule(globalRulesDir(), "review-before-pr");

    assert.deepEqual(loadRules(project, OFF).rules, []);
    assert.equal(loadRules(project, ON).rules.length, 1);
  });

  test("AC1 a malformed rule is not even reported while the capability is off", () => {
    writeRule(projectRulesDir(project), "broken", "no frontmatter here");

    assert.deepEqual(loadRules(project, OFF).errors, []);
    assert.equal(loadRules(project, ON).errors.length, 1);
  });

  /** invariant: a machine that never opted in carries no new file. */
  test("AC1 nothing is written while the capability is off", () => {
    observe(project, OFF, JURY_STOPPED, SEEN);
    assert.equal(existsSync(observationsPath(project)), false);

    observe(project, ON, JURY_STOPPED, SEEN);
    assert.equal(existsSync(observationsPath(project)), true, "and recorded once it is on");
  });

  test("AC1 an action nothing else objects to is abstained on while the capability is off", () => {
    writeRule(projectRulesDir(project), "review-before-pr");

    assert.equal(decideAction(project, OFF, PR_OPEN, CONTEXT).decision.kind, "abstain");
    assert.equal(decideAction(project, ON, PR_OPEN, CONTEXT).decision.kind, "deny");
  });
});

describe("decideAction", () => {
  /** AC1 — the inert path: switched on, nothing declared, nothing to say. */
  test("AC1 with no rule files there is no decision and no error", () => {
    const verdict = decideAction(project, ON, PR_OPEN, CONTEXT);

    assert.equal(verdict.decision.kind, "abstain");
    assert.deepEqual(verdict.outcomes, []);
    assert.deepEqual(verdict.errors, []);
  });

  test("AC3 a rule whose proof was observed against this sha does not block", () => {
    writeRule(projectRulesDir(project), "review-before-pr");
    observe(project, ON, JURY_STOPPED, SEEN);

    const verdict = decideAction(project, ON, PR_OPEN, CONTEXT);

    assert.equal(verdict.decision.kind, "abstain");
    assert.deepEqual(verdict.outcomes, []);
  });

  /** AC4 — proof against another commit is proof about other code. */
  test("AC4 the same proof does not carry over to a later commit", () => {
    writeRule(projectRulesDir(project), "review-before-pr");
    observe(project, ON, JURY_STOPPED, SEEN);

    const later = decideAction(project, ON, PR_OPEN, { ...CONTEXT, sha: "def5678" });

    assert.equal(later.decision.kind, "deny");
  });

  test("AC2 an unrelated command is not the trigger, even with the rule active", () => {
    writeRule(projectRulesDir(project), "review-before-pr");

    assert.equal(
      decideAction(project, ON, { ...PR_OPEN, command: "git status" }, CONTEXT).decision.kind,
      "abstain",
    );
  });

  /** AC10 — one broken rule does not disarm the others, and the breakage is still reported. */
  test("AC10 a malformed rule is reported while a valid one still decides", () => {
    writeRule(projectRulesDir(project), "review-before-pr");
    writeRule(projectRulesDir(project), "broken", "no frontmatter here");

    const verdict = decideAction(project, ON, PR_OPEN, CONTEXT);

    assert.equal(verdict.decision.kind, "deny");
    assert.equal(verdict.errors.length, 1);
    assert.equal(verdict.errors[0]?.name, "broken");
  });

  /** AC12 — the project's copy wins by name, and its body is the reason it does. */
  test("AC12 a project rule switching a global one off leaves nothing to enforce here", () => {
    writeRule(globalRulesDir(), "review-before-pr");
    writeRule(
      projectRulesDir(project),
      "review-before-pr",
      `---\non: pr-open\nenabled: false\notherwise: deny\n---\nInfra repo: reviewed in the PR.`,
    );

    const verdict = decideAction(project, ON, PR_OPEN, CONTEXT);

    assert.equal(verdict.decision.kind, "abstain");
    assert.equal(loadRules(project, ON).disabled.length, 1, "and it is still reportable, not silently gone");
  });
});
