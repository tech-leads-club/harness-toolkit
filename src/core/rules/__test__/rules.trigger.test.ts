import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { firingRules, mentionsGhApi, mentionsMcpAct, normalizeMcpToolName, triggerMatches } from "../rules.trigger.ts";
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

  /**
   * AD-127 — a rule stayed silently unfired in production behind a transparent shell proxy, because the old
   * matcher anchored to word 0. WRAP-01/WRAP-02: any prefix, any number of layers, still fires.
   */
  test("AD-127 WRAP-01/WRAP-02 pr-open fires behind one or more transparent wrapper prefixes", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "rtk gh pr create --fill" }),
      true,
      "one wrapper layer",
    );
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "sudo -u ci rtk gh pr create" }),
      true,
      "multiple wrapper layers stacked",
    );
  });

  /** AD-127 WRAP-03: commit and push fire the same way behind a wrapper. */
  test("AD-127 WRAP-03 commit and push fire behind a wrapper too", () => {
    assert.equal(
      triggerMatches({ kind: "commit" }, { event: "tool.before", command: "time git commit -m x" }),
      true,
    );
    assert.equal(
      triggerMatches({ kind: "push" }, { event: "tool.before", command: "env FOO=bar git push origin main" }),
      true,
    );
  });

  /**
   * AD-127 WRAP-04: the draft exclusion still holds once the command is wrapped
   * ([/decisions/ad-118.md](/decisions/ad-118.md)).
   */
  test("AD-127 WRAP-04 the draft exclusion still applies behind a wrapper", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "rtk gh pr create --draft" }),
      false,
    );
  });

  /** AD-127 WRAP-05: the wrapper tolerance composes with the AD-121 basename fallback. */
  test("AD-127 WRAP-05 a wrapped command still gets the basename fallback for the real verb's path", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        { event: "tool.before", command: "time /usr/local/bin/gh pr create" },
      ),
      true,
    );
  });

  /** AD-127 WRAP-07: position-agnostic scanning must not blur an unrelated command into `commit`/`push`. */
  test("AD-127 WRAP-07 docker commit is not git commit", () => {
    assert.equal(
      triggerMatches({ kind: "commit" }, { event: "tool.before", command: "docker commit abc image" }),
      false,
    );
  });

  /**
   * AD-128 — the exact incident: `gh pr create` was blocked, the agent switched to `gh api` and the pull
   * request opened ungated. APIG-01..06 close this specific, evidenced bypass.
   */
  test("APIG-01 pr-open fires on the gh api call that actually opened the incident's pull request", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        {
          event: "tool.before",
          command: "gh api repos/o/r/pulls -f title='x' -f head='feat/x' -f base='main' -f body='y'",
        },
      ),
      true,
    );
  });

  test("APIG-02 pr-open fires the same way with an explicit -X POST / --method POST", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        { event: "tool.before", command: "gh api repos/o/r/pulls -X POST -f title=x -f head=y -f base=z" },
      ),
      true,
    );
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        { event: "tool.before", command: "gh api --method POST repos/o/r/pulls -f title=x" },
      ),
      true,
      "the method flag before the endpoint still resolves correctly",
    );
  });

  test("APIG-03 pr-open does not fire on a bare GET listing pull requests", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "tool.before", command: "gh api repos/o/r/pulls" }),
      false,
    );
  });

  test("APIG-04 pr-open does not fire when params are present but --method GET forces a read", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        { event: "tool.before", command: "gh api repos/o/r/pulls -f q=is:open --method GET" },
      ),
      false,
    );
  });

  test("APIG-05 pr-open via gh api still fires behind a wrapper prefix", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        { event: "tool.before", command: "rtk gh api repos/o/r/pulls -f title=x -f head=y -f base=z" },
      ),
      true,
    );
  });

  test("APIG-06 pr-open via gh api fires with a leading-slash path or a full URL", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        { event: "tool.before", command: "gh api /repos/o/r/pulls -f title=x" },
      ),
      true,
      "leading slash",
    );
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        { event: "tool.before", command: "gh api https://api.github.com/repos/o/r/pulls -f title=x" },
      ),
      true,
      "full URL",
    );
  });

  /** APIG-07..09 — the same class of bypass for `push`, closed alongside `pr-open`'s, no evidenced incident yet. */
  test("APIG-07 push fires on gh api updating a git ref (the API equivalent of pushing to an existing branch)", () => {
    assert.equal(
      triggerMatches(
        { kind: "push" },
        { event: "tool.before", command: "gh api repos/o/r/git/refs/heads/main -X PATCH -f sha=abc123" },
      ),
      true,
    );
  });

  test("APIG-08 push fires on gh api creating a new git ref (implicit POST from the body flags)", () => {
    assert.equal(
      triggerMatches(
        { kind: "push" },
        { event: "tool.before", command: "gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc123" },
      ),
      true,
    );
  });

  test("APIG-09 push does not fire on a bare GET reading a git ref", () => {
    assert.equal(
      triggerMatches(
        { kind: "push" },
        { event: "tool.before", command: "gh api repos/o/r/git/refs/heads/main" },
      ),
      false,
    );
  });

  /** APIG-10 — `pr-merge`'s CLI shape, same `containsPhrase`/`matchesShape` machinery as every other shape. */
  test("APIG-10 pr-merge fires on gh pr merge and not on gh pr view", () => {
    assert.equal(
      triggerMatches({ kind: "pr-merge" }, { event: "tool.before", command: "gh pr merge 42" }),
      true,
    );
    assert.equal(
      triggerMatches(
        { kind: "pr-merge" },
        { event: "tool.before", command: "gh pr merge 42 --squash --auto" },
      ),
      true,
      "flags do not change the act",
    );
    assert.equal(
      triggerMatches({ kind: "pr-merge" }, { event: "tool.before", command: "gh pr view 42" }),
      false,
    );
  });

  test("a shell trigger with no command cannot fire pr-merge either", () => {
    assert.equal(triggerMatches({ kind: "pr-merge" }, { event: "tool.before" }), false);
  });

  /** APIG-11/12 — the gh api equivalent of gh pr merge: PUT to a path ending in /merge under pulls. */
  test("APIG-11 pr-merge fires on the gh api merge endpoint", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-merge" },
        { event: "tool.before", command: "gh api repos/o/r/pulls/42/merge -X PUT" },
      ),
      true,
    );
  });

  /**
   * Verifier finding — the method check (`methods: ["PUT"]`) alone must not be enough; the `lastSegment`
   * guard has to be exercised with the *right* method and the *wrong* path, or a mutant that deletes the
   * `lastSegment` check survives behind the method check alone.
   */
  test("pr-merge does not fire on a PUT to the bare pull request path, only on one ending in /merge", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-merge" },
        { event: "tool.before", command: "gh api repos/o/r/pulls/42 -X PUT" },
      ),
      false,
    );
  });

  test("APIG-12 pr-merge does not fire on gh api reading a single pull request", () => {
    assert.equal(
      triggerMatches({ kind: "pr-merge" }, { event: "tool.before", command: "gh api repos/o/r/pulls/42" }),
      false,
    );
  });

  /**
   * Risks & Concerns (design.md) — the concrete distinguishing case: PATCH to /pulls/{n} edits metadata (a
   * title, say) and must not be mistaken for a merge just because "pulls" appears in the path too.
   */
  test("pr-merge does not fire on an unrelated PATCH editing a pull request's title via gh api", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-merge" },
        { event: "tool.before", command: "gh api repos/o/r/pulls/42 -X PATCH -f title='new title'" },
      ),
      false,
    );
  });

  /**
   * AD-130 — the exact incident: `gh api` recognized *any* repository's push as this project's own. ARS-01..04
   * close it: the API path's owner/repo now has to match `context.repoRemote`.
   */
  describe("AD-130 repoRemote scoping for the gh api shapes", () => {
    const SAME_REPO = { owner: "acme", repo: "widgets" };
    const OTHER_REPO = { owner: "other-owner", repo: "unrelated-repo" };

    test("ARS-01 push still fires when the gh api call targets the local repo's own remote", () => {
      assert.equal(
        triggerMatches(
          { kind: "push" },
          {
            event: "tool.before",
            command: "gh api -X PATCH repos/acme/widgets/git/refs/heads/main -f sha=abc",
            repoRemote: SAME_REPO,
          },
        ),
        true,
      );
    });

    test("ARS-02 push does not fire when the gh api call targets an unrelated repository", () => {
      assert.equal(
        triggerMatches(
          { kind: "push" },
          {
            event: "tool.before",
            command: "gh api -X PATCH repos/other-owner/unrelated-repo/git/refs/heads/main -f sha=abc",
            repoRemote: SAME_REPO,
          },
        ),
        false,
      );
    });

    test("ARS-02 the same holds for pr-open and pr-merge against an unrelated repository", () => {
      assert.equal(
        triggerMatches(
          { kind: "pr-open" },
          {
            event: "tool.before",
            command: "gh api repos/other-owner/unrelated-repo/pulls -f title=x -f head=y -f base=z",
            repoRemote: SAME_REPO,
          },
        ),
        false,
      );
      assert.equal(
        triggerMatches(
          { kind: "pr-merge" },
          {
            event: "tool.before",
            command: "gh api repos/other-owner/unrelated-repo/pulls/42/merge -X PUT",
            repoRemote: SAME_REPO,
          },
        ),
        false,
      );
    });

    test("ARS-02 the same owner but a different repository still does not match — both segments are checked", () => {
      assert.equal(
        triggerMatches(
          { kind: "push" },
          {
            event: "tool.before",
            command: "gh api -X PATCH repos/acme/some-other-repo/git/refs/heads/main -f sha=abc",
            repoRemote: SAME_REPO,
          },
        ),
        false,
        "acme matches, but widgets !== some-other-repo",
      );
    });

    test("ARS-03 a resolved-but-absent local remote (null) fails every gh api shape, not just a mismatch", () => {
      assert.equal(
        triggerMatches(
          { kind: "push" },
          {
            event: "tool.before",
            command: "gh api -X PATCH repos/acme/widgets/git/refs/heads/main -f sha=abc",
            repoRemote: null,
          },
        ),
        false,
      );
    });

    test("ARS-04 an omitted repoRemote (undefined) is unchanged from before AD-130", () => {
      assert.equal(
        triggerMatches(
          { kind: "push" },
          {
            event: "tool.before",
            command: "gh api -X PATCH repos/other-owner/unrelated-repo/git/refs/heads/main -f sha=abc",
          },
        ),
        true,
        "no repoRemote supplied at all — the caller didn't resolve this dimension, so the path/method check alone still decides",
      );
    });

    test("ARS-04 CLI-form shapes are unaffected by repoRemote entirely, matched or mismatched", () => {
      assert.equal(
        triggerMatches(
          { kind: "push" },
          { event: "tool.before", command: "git push origin main", repoRemote: OTHER_REPO },
        ),
        true,
      );
      assert.equal(
        triggerMatches(
          { kind: "pr-merge" },
          { event: "tool.before", command: "gh pr merge 42", repoRemote: OTHER_REPO },
        ),
        true,
      );
    });
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

/**
 * ARS-05/06 — `isShipCommand`/`rulesDecision` gate `localRepoRemote`'s process spawn behind this exact
 * check: a command that cannot possibly match an API shape (`mentionsGhApi` false) never pays for the
 * remote lookup at all, and one that does pays for it once. Node's `node:test` mock cannot reliably
 * intercept a builtin module's function called through another module's named import in this runtime
 * (confirmed by trying it, not assumed), so the actual "was the process spawned" property is proven here,
 * on the pure decision the two callers act on, rather than by spying on the spawn itself
 * ([/decisions/ad-130.md](/decisions/ad-130.md)).
 */
describe("mentionsGhApi", () => {
  test("ARS-05 true for a gh api call, including behind a transparent wrapper", () => {
    assert.equal(mentionsGhApi("gh api -X PATCH repos/acme/widgets/git/refs/heads/main -f sha=x"), true);
    assert.equal(mentionsGhApi("rtk gh api repos/acme/widgets/pulls -f title=x"), true, "AD-127 composes");
  });

  test("ARS-05 false for the CLI shapes — they never read repoRemote, so nothing needs to resolve it", () => {
    assert.equal(mentionsGhApi("git push origin main"), false);
    assert.equal(mentionsGhApi("gh pr create --fill"), false);
    assert.equal(mentionsGhApi("gh pr merge 42"), false);
  });

  test("ARS-05 false for a command with no relation to gh at all", () => {
    assert.equal(mentionsGhApi("ls -la"), false);
    assert.equal(mentionsGhApi("npm test"), false);
  });

  test("ARS-05 false when the words appear only inside a heredoc body, same as every other shell trigger", () => {
    const command = "cat <<EOF > notes.md\nremember to run gh api later\nEOF";
    assert.equal(mentionsGhApi(command), false);
  });
});

/**
 * AD-135 — a third grammar for the same act: an MCP tool call, alongside the CLI words `SHELL_SHAPES` already
 * reads and the REST path+method `API_SHAPES` already reads. Confirmed in production: `gh pr create` and
 * `gh api .../pulls` attempts in one session were correctly denied by the operator's own `pr-open` rule; the
 * GitHub MCP server's `create_pull_request` tool, invoked in the same session, reached `triggerMatches` with
 * no `command` at all and was never evaluated.
 */
describe("normalizeMcpToolName", () => {
  test("PMS-N1 a bare tool name (Cursor's beforeMCPExecution payload) passes through unchanged", () => {
    assert.equal(normalizeMcpToolName("create_pull_request"), "create_pull_request");
  });

  test("PMS-N2 Claude Code's mcp__<server>__<tool> convention strips to the tool name", () => {
    assert.equal(normalizeMcpToolName("mcp__github__create_pull_request"), "create_pull_request");
  });

  test("PMS-N3 a server name containing its own underscore still strips to the tool name", () => {
    assert.equal(
      normalizeMcpToolName("mcp__github_enterprise__create_pull_request"),
      "create_pull_request",
      "the split is on the LAST __, not the first",
    );
  });

  test("PMS-N4 Cursor's host-prefixed generic-tool form strips to the tool name", () => {
    assert.equal(normalizeMcpToolName("MCP:create_pull_request"), "create_pull_request");
  });
});

describe("triggerMatches — MCP shape (pr-open)", () => {
  test("PMS-01 a bare create_pull_request tool call fires pr-open", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "mcp.before", toolName: "create_pull_request" }),
      true,
    );
  });

  test("PMS-02 Claude Code's mcp__<server>__create_pull_request fires pr-open, any server name", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "mcp.before", toolName: "mcp__github__create_pull_request" }),
      true,
    );
  });

  test("PMS-03 Cursor's MCP:create_pull_request fires pr-open", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "mcp.before", toolName: "MCP:create_pull_request" }),
      true,
    );
  });

  test("PMS-04 an unrelated or merely-similar MCP tool name does not fire — exact match, not substring", () => {
    for (const toolName of [
      "create_pull_request_comment",
      "list_pull_requests",
      "mcp__github__update_pull_request",
    ]) {
      assert.equal(triggerMatches({ kind: "pr-open" }, { event: "mcp.before", toolName }), false, toolName);
    }
  });

  test("PMS-05 a shell command still matches exactly as before — the MCP path is additive", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, { event: "shell.before", command: "gh pr create --fill" }),
      true,
    );
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        { event: "shell.before", command: "gh api repos/acme/widgets/pulls -X POST -f title=x" },
      ),
      true,
    );
  });

  test("PMS-06 neither command nor toolName present — no act to recognize", () => {
    assert.equal(triggerMatches({ kind: "pr-open" }, { event: "mcp.before" }), false);
  });
});

describe("triggerMatches — MCP shape repo scope (pr-open)", () => {
  const context = (toolInput: Record<string, unknown>, repoRemote?: { owner: string; repo: string } | null) => ({
    event: "mcp.before",
    toolName: "create_pull_request",
    toolInput,
    repoRemote,
  });

  test("PMS-07 toolInput names the local repository — fires", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        context({ owner: "acme", repo: "widgets" }, { owner: "acme", repo: "widgets" }),
      ),
      true,
    );
  });

  test("PMS-08 toolInput names a different repository — does not fire", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        context({ owner: "acme", repo: "other-repo" }, { owner: "acme", repo: "widgets" }),
      ),
      false,
    );
  });

  test("PMS-09 repoRemote resolved to null (no confirmable local repo) — fails the scoped match", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, context({ owner: "acme", repo: "widgets" }, null)),
      false,
    );
  });

  test("PMS-10 repoRemote never resolved (undefined) — fires without a scope check, matching matchesApiShape", () => {
    assert.equal(
      triggerMatches({ kind: "pr-open" }, context({ owner: "acme", repo: "widgets" })),
      true,
    );
  });

  test("PMS-11 toolInput carries no owner/repo fields — fires without a scope check", () => {
    assert.equal(
      triggerMatches(
        { kind: "pr-open" },
        context({ title: "fix: something" }, { owner: "acme", repo: "widgets" }),
      ),
      true,
    );
  });
});

describe("mentionsMcpAct", () => {
  test("PMS-12 true for every recognized MCP shape's tool name, in any provider's decoration", () => {
    assert.equal(mentionsMcpAct("create_pull_request"), true);
    assert.equal(mentionsMcpAct("mcp__github__create_pull_request"), true);
    assert.equal(mentionsMcpAct("MCP:create_pull_request"), true);
  });

  test("PMS-13 false for an unrelated tool name or undefined", () => {
    assert.equal(mentionsMcpAct("Read"), false);
    assert.equal(mentionsMcpAct("mcp__github__list_pull_requests"), false);
    assert.equal(mentionsMcpAct(undefined), false);
  });
});
