import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { firingRules, triggerMatches } from "../rules.trigger.ts";
import type { Rule } from "../rules.types.ts";

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    name: "r",
    tier: "project",
    enabled: true,
    on: { kind: "pr-open" },
    require: [{ kind: "gate", value: "test", since: "head" }],
    otherwise: "deny",
    body: "b",
    ...overrides,
  };
}

describe("triggerMatches", () => {
  test("AC2 pr-open fires on the command that opens one", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "gh pr create" }),
      true,
    );
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        { event: "tool.before", command: "gh pr create --fill --base main" },
      ),
      true,
      "flags do not change the act",
    );
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "gh pr ready 42" }),
      true,
    );
  });

  /**
   * why: a draft is not open for review, and it is the only way a proof that itself needs the pull request to
   * exist — `gh pr view`, for one — can ever run at all ([/decisions/ad-118.md](/decisions/ad-118.md)).
   */
  test("AD-118 pr-open does not fire on a draft, but does on the real create and on ready", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "gh pr create --draft" }),
      false,
      "--draft",
    );
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "gh pr create -d --fill" }),
      false,
      "-d",
    );
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "gh pr create --fill" }),
      true,
      "a real, non-draft create still fires",
    );
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "gh pr ready 42" }),
      true,
      "converting a draft to ready still fires",
    );
  });

  /** AC9 — the reason this uses the tokenizer instead of a substring test. */
  test("AC9 a triggering sub-command inside a compound command fires", () => {
    for (const command of [
      "npm test && gh pr create",
      "npm test; gh pr create --fill",
      "echo hi | gh pr create",
      "npm test &&\ngh pr create",
    ]) {
      assert.equal(triggerMatches({ kind: "pr-open" }, { event: "tool.before", command }), true, command);
    }
  });

  /**
   * AC9 — hazard: a heredoc body is data being written. A trigger that fired on it would refuse
   * `cat <<EOF > notes.md` for the words inside the note.
   */
  test("AC9 the same words inside a heredoc body do not fire", () => {
    const prose = "cat <<EOF > notes.md\nremember to run gh pr create later\nEOF";

    assert.equal(triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: prose }), false);
  });

  /**
   * hazard: this is the case that proves the heredoc strip rather than the prefix match. A body line that *opens*
   * with the shape looks exactly like the command when the body is left in — the first version of this test used
   * prose, so removing the strip changed nothing and the mutation survived
   * ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  test("AC9 a heredoc body line that starts with the command does not fire either", () => {
    const command = "cat <<EOF > runbook.md\ngh pr create --fill\nEOF";

    assert.equal(triggerMatches({ kind: "pr-open" }, { event: "tool.before", command }), false);
  });

  /** invariant: and the command *around* the heredoc still fires, or the strip would hide a real act. */
  test("AC9 a real command next to a heredoc still fires", () => {
    const command = "cat <<EOF > runbook.md\nnotes\nEOF\ngh pr create";

    assert.equal(triggerMatches({ kind: "pr-open" }, { event: "tool.before", command }), true);
  });

  test("a command that merely mentions the words as arguments does not fire", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: 'echo "gh pr create"' }),
      false,
      "a quoted argument is not a command",
    );
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "git log --grep 'gh pr create'" }),
      false,
    );
  });

  test("commit and push fire on their own shapes and not on each other", () => {
    assert.equal(
      triggerMatches({ kind: "commit" }, { event: "tool.before", command: "git commit -m x" }),
      true,
    );
    assert.equal(
      triggerMatches({ kind: "push" }, { event: "tool.before", command: "git push origin main" }),
      true,
    );
    assert.equal(triggerMatches({ kind: "commit" }, { event: "tool.before", command: "git push" }), false);
  });

  test("stop fires on the stop event and nothing else", () => {
    assert.equal(triggerMatches({ kind: "stop" }, { event: "stop" }), true);
    assert.equal(triggerMatches({ kind: "stop" }, { event: "tool.before", command: "git push" }), false);
  });

  test("tool fires on an exact tool name", () => {
    assert.equal(
      triggerMatches({ kind: "tool", name: "Write" }, { event: "tool.before", toolName: "Write" }),
      true,
    );
    assert.equal(
      triggerMatches({ kind: "tool", name: "Write" }, { event: "tool.before", toolName: "Read" }),
      false,
    );
  });

  /** why a phrase: the operator wrote three words in an order, not a substring. */
  test("command matches the operator's phrase in order, inside a compound command", () => {
    const trigger = { kind: "command", pattern: "gh pr review" } as const;

    assert.equal(triggerMatches(trigger, { event: "tool.before", command: "gh pr review --approve" }), true);
    assert.equal(triggerMatches(trigger, { event: "tool.before", command: "x && gh pr review 42" }), true);
    assert.equal(
      triggerMatches(trigger, { event: "tool.before", command: "gh review pr" }),
      false,
      "order matters",
    );
    assert.equal(triggerMatches(trigger, { event: "tool.before", command: "gh pr list" }), false);
  });

  /**
   * AD-121 — a bare token names the act, not the location. Confirmed live: a real proof stayed unsatisfied
   * forever because every recorded invocation ran the script by its full path.
   */
  test("AD-121 a bare-filename token matches the script run by any path to it", () => {
    const trigger = { kind: "command", pattern: "build.sh" } as const;

    assert.equal(
      triggerMatches(trigger, {
        event: "tool.before",
        command: "bash /home/user/tools/scripts/build.sh --release",
      }),
      true,
      "absolute path",
    );
    assert.equal(
      triggerMatches(trigger, { event: "tool.before", command: "bash ./scripts/build.sh" }),
      true,
      "relative path",
    );
    assert.equal(
      triggerMatches(trigger, { event: "tool.before", command: "bash build.sh" }),
      true,
      "bare, unchanged from before",
    );
  });

  /** AD-121 — the fallback is a basename match, not a substring scan. */
  test("AD-121 a bare-filename token does not match another file that merely ends with it", () => {
    const trigger = { kind: "command", pattern: "build.sh" } as const;

    assert.equal(
      triggerMatches(trigger, { event: "tool.before", command: "bash /scripts/rebuild.sh" }),
      false,
    );
  });

  /** AD-121 — a token the operator wrote as a path is a location, and a location is exact or wrong. */
  test("AD-121 a token that already names a path is not given the same fallback", () => {
    const trigger = { kind: "command", pattern: "scripts/build.sh" } as const;

    assert.equal(
      triggerMatches(trigger, {
        event: "tool.before",
        command: "bash /home/user/tools/scripts/build.sh",
      }),
      false,
      "the operator's own path prefix does not get a suffix fallback",
    );
  });

  /** AD-121 — the basename fallback applies per token, so a multi-word phrase is not weakened by adding it. */
  test("AD-121 a multi-word phrase still requires every word, basename fallback or not", () => {
    const trigger = { kind: "command", pattern: "gh pr review" } as const;

    assert.equal(
      triggerMatches(trigger, { event: "tool.before", command: "/usr/local/bin/gh pr review --approve" }),
      true,
      "the CLI binary invoked by its full path still counts as gh",
    );
    assert.equal(
      triggerMatches(trigger, { event: "tool.before", command: "/usr/local/bin/gh pr list" }),
      false,
      "still requires the rest of the phrase",
    );
  });

  test("a shell trigger with no command in the event cannot fire", () => {
    assert.equal(triggerMatches({ kind: "pr-open" }, { event: "tool.before" }), false);
    assert.equal(triggerMatches({ kind: "command", pattern: "x" }, { event: "stop" }), false);
  });
});

describe("firingRules", () => {
  test("only the rules whose trigger matches are returned", () => {
    const rules = [
      rule({ name: "pr", on: { kind: "pr-open" } }),
      rule({ name: "stop", on: { kind: "stop" } }),
    ];

    const firing = firingRules(rules, { event: "tool.before", command: "gh pr create" });

    assert.deepEqual(
      firing.map((entry) => entry.name),
      ["pr"],
    );
  });

  /** invariant: a disabled rule exists to switch a global off. It must never fire. */
  test("AC12 a disabled rule never fires even when its trigger matches", () => {
    const firing = firingRules([rule({ enabled: false })], {
      event: "tool.before",
      command: "gh pr create",
    });

    assert.deepEqual(firing, []);
  });
});
