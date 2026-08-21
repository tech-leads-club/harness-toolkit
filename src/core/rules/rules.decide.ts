/**
 * What the harness answers when a rule fires and its proof is missing.
 *
 * invariant: pure, and posture only reaches `ask`. `deny`, `follow-up` and `warn` are verification, and the
 * evidence bar is identical at all three postures — a posture that switched a check off is the defect the posture
 * feature exists to remove ([/decisions/ad-025.md](/decisions/ad-025.md) item 4).
 */
import type { Decision } from "../../contracts/decision.ts";
import type { OperatorMode } from "../policy/policy.types.ts";
import { missingProofs, type Observation, type ProofContext, proofLabel } from "./rules.proof.ts";
import type { Rule, RuleVerdict } from "./rules.types.ts";

/**
 * `ask` is an interruption, which is the one thing posture governs. `paired` promises a check-in before a sizable
 * move, so it asks. `solo` and `focus` name what reaches the operator — a destructive action, a dead end, and for
 * `solo` a real ambiguity — and a missing proof is none of those, so the harness settles it itself.
 *
 * invariant: it hardens rather than softens. Softening would let a posture clear a verification, which is exactly
 * what posture must never do — and it is the same direction `ask` already degrades in on a host that cannot ask.
 */
export function effectiveVerdict(declared: RuleVerdict, mode: OperatorMode): RuleVerdict {
  return declared === "ask" && mode !== "paired" ? "deny" : declared;
}

/**
 * why the body verbatim: the rule's instruction is the operator's, with their project's context and their
 * attachments. The harness adds the rule's name and what is missing, and changes nothing else.
 */
export function ruleMessage(rule: Rule, missing: readonly ReturnType<typeof proofLabel>[]): string {
  const head = `rule ${rule.name} (${rule.tier}): missing ${missing.join(", ")}`;
  return rule.body.trim() === "" ? head : `${head}\n\n${rule.body.trim()}`;
}

export type RuleOutcome = {
  rule: Rule;
  verdict: RuleVerdict;
  missing: string[];
  message: string;
};

/**
 * invariant: a rule whose proof holds produces nothing at all. Silence on the healthy path is what keeps this
 * from being a wall an operator learns to ignore ([/decisions/ad-034.md](/decisions/ad-034.md)).
 */
export function evaluateRules(
  rules: readonly Rule[],
  observations: readonly Observation[],
  context: ProofContext & { mode: OperatorMode },
): RuleOutcome[] {
  const outcomes: RuleOutcome[] = [];
  for (const rule of rules) {
    const missing = missingProofs(rule, observations, context);
    if (missing.length === 0) {
      continue;
    }
    const labels = missing.map(proofLabel);
    outcomes.push({
      rule,
      verdict: effectiveVerdict(rule.otherwise, context.mode),
      missing: labels,
      message: ruleMessage(rule, labels),
    });
  }
  return outcomes;
}

const SEVERITY: Record<RuleVerdict, number> = { warn: 0, "follow-up": 1, ask: 2, deny: 3 };

/**
 * invariant: the strictest outcome decides, which is how every host resolves two hooks answering one event. A
 * `warn` beside a `deny` must not soften the `deny`.
 */
export function strictest(outcomes: readonly RuleOutcome[]): RuleOutcome | null {
  return outcomes.reduce<RuleOutcome | null>(
    (best, outcome) => (best === null || SEVERITY[outcome.verdict] > SEVERITY[best.verdict] ? outcome : best),
    null,
  );
}

/**
 * The decision for an action-time trigger. `follow-up` and `warn` never block an action — they are answers to the
 * end of a turn and to the record, so at action time they abstain and the stop rail handles them.
 */
export function actionDecision(outcome: RuleOutcome): Decision {
  const rule = `rule:${outcome.rule.name}`;
  if (outcome.verdict === "deny") {
    return { kind: "deny", reason: outcome.message, rule };
  }
  if (outcome.verdict === "ask") {
    return { kind: "ask", reason: outcome.message, userNote: outcome.message, rule };
  }
  return { kind: "abstain" };
}
