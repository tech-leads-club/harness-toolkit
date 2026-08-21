/**
 * What an operator rule is.
 *
 * why two closed vocabularies: a gate may only rest on something the harness observed, and a trigger may only be
 * something it can recognise. An open expression language would let an operator declare a rule the harness cannot
 * evaluate, and the honest answer to that is a parse error rather than a rule that never fires
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */

/** Where the rule came from. `project` replaces a `global` of the same name, and both apply otherwise. */
export type RuleTier = "global" | "project";

/**
 * What happens when the proof is missing.
 *
 * invariant: `deny`, `follow-up` and `warn` are verification and are identical at every posture. `ask` is an
 * interruption, which is the one thing posture governs ([/decisions/ad-025.md](/decisions/ad-025.md)).
 */
export type RuleVerdict = "deny" | "ask" | "follow-up" | "warn";

export const RULE_VERDICTS: ReadonlySet<string> = new Set<RuleVerdict>(["deny", "ask", "follow-up", "warn"]);

/** When the rule is evaluated. */
export type RuleTrigger =
  | { kind: "pr-open" }
  | { kind: "commit" }
  | { kind: "push" }
  | { kind: "stop" }
  | { kind: "tool"; name: string }
  | { kind: "command"; pattern: string };

/**
 * What counts as proof, and how fresh it must be.
 *
 * why `head` by default: a review of the code as it was two commits ago is not a review of what the pull request
 * carries.
 */
export type ProofWindow = "head" | "session";

export type RuleProof =
  | { kind: "subagent"; value: string; since: ProofWindow }
  | { kind: "command"; value: string; since: ProofWindow }
  | { kind: "gate"; value: string; since: ProofWindow }
  | { kind: "file"; value: string; since: ProofWindow };

export const PROOF_KINDS: ReadonlySet<string> = new Set(["subagent", "command", "gate", "file"]);

export type Rule = {
  /** The file name without its extension. This is the id the tiers dedupe on. */
  name: string;
  tier: RuleTier;
  enabled: boolean;
  on: RuleTrigger;
  /** invariant: every proof must hold. There is no boolean algebra here on purpose. */
  require: RuleProof[];
  otherwise: RuleVerdict;
  /** The operator's own text, injected verbatim when the rule fires. */
  body: string;
};

/** A rule that could not be read. Named, so `doctor` can report it instead of the harness ignoring it silently. */
export type RuleError = { name: string; tier: RuleTier; error: string };

export type RuleSet = { rules: Rule[]; errors: RuleError[]; disabled: Rule[] };
