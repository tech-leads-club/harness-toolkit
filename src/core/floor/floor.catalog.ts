import type { FloorRule } from "./floor.service.ts";

export type FloorRuleDoc = {
  /** What the rule refuses, in the terms an operator reading a denial would use. */
  denies: string;
  /** The one case that reads like it should be denied and is not, where there is one worth stating. */
  allows?: string;
};

/**
 * why: the README described the floor as "five rules" above a table of six, and `docs/architecture.md` listed
 * eight — two of which are not floor rules at all. The floor is the part no configuration can reach, so a
 * hand-copied count of it is the worst place in the product for a number to drift.
 *
 * invariant: keyed by `FloorRule`, so adding a member to that union without describing it here fails the
 * typecheck rather than shipping an undocumented rule.
 */
export const FLOOR_RULES: Record<FloorRule, FloorRuleDoc> = {
  "outside-project-destruction": {
    denies:
      "a destructive command whose target resolves outside the repository and outside the OS temp directory",
    allows: "the same command inside the repository, or inside the temp directory",
  },
  "unprovable-destruction": {
    denies:
      "a destructive verb whose target is a variable, a command substitution, or otherwise built at runtime — the harness cannot see what it would delete",
    allows: "a literal path it can resolve and check",
  },
  "secret-access": {
    denies:
      "a read that would copy a credential into the transcript — `.env`, `~/.ssh`, `~/.aws`, `*.pem` and similar through a shell reader or the editor's own read tool, and the instance metadata service through any verb that speaks to the network",
    allows: "searching local files for the literal address, because `grep` and its kin make no request",
  },
  "history-rewrite": {
    denies: "`git push --force`",
    allows: "`--force-with-lease`, which refuses on its own when the remote moved",
  },
  "machine-control": {
    denies: "`shutdown`, `reboot`, `halt`, `poweroff`",
  },
  "unprovable-execution": {
    denies:
      "a program fetched over the network and handed to a shell — piped, process-substituted, or inside a shell's `-c`/`eval` substitution. The gate cannot read what would run",
    allows: "a fetch with no shell downstream, and a shell fed a local file the gate can read",
  },
  "policy-surface-write": {
    denies:
      "every route an agent has to harness policy and state — a shell redirect, an interpreter, a heredoc program, or a write tool — in the project and under the runtime home, plus the mutating `tlc harness` subcommands from inside a session",
    allows:
      "reading them with a proven reader (`cat`, `head`, `grep`, `jq`, `ls`, `stat`, `test`), and `tlc harness handoff` for the handoff state",
  },
};

export const FLOOR_RULE_IDS = Object.keys(FLOOR_RULES) as FloorRule[];
