/**
 * Whether the proof a rule demands exists.
 *
 * invariant: a proof is satisfied only by something the harness itself observed. Never by the agent asserting it,
 * and never by a model's verdict — the same change gets different verdicts across runs, so a probabilistic
 * reviewer cannot be an enforcement mechanism ([/decisions/ad-100.md](/decisions/ad-100.md)).
 *
 * invariant: pure. The store hands over the observations; this decides what they mean.
 */
import { matchesPhrase } from "./rules.trigger.ts";
import type { Rule, RuleProof } from "./rules.types.ts";

/**
 * One thing the harness saw.
 *
 * why `sha`: freshness is part of the proof. A review of the code as it was two commits ago reviewed something
 * else, so an observation carries the HEAD it was made against and `since HEAD` compares them.
 */
export type Observation = {
  kind: RuleProof["kind"];
  /** The subagent type, the command as words, the gate name, or the path. */
  value: string;
  /** HEAD when it was observed. `null` when the project is not a git checkout. */
  sha: string | null;
  sessionKey: string;
  at: string;
};

export type ProofContext = { sha: string | null; sessionKey: string };

/**
 * why a suffix and a directory instead of a glob engine: nothing else in this repository needs globs, and an
 * engine written for one caller is generality nobody asked for. Three shapes, each stated: an exact path,
 * `*.<ext>`, and a `dir/` prefix. A rule that needs more than that is a decision with a reason, not a silent
 * extension of this function.
 */
function pathMatches(pattern: string, path: string): boolean {
  if (pattern === path) {
    return true;
  }
  if (pattern.startsWith("*")) {
    return path.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("/")) {
    return path.startsWith(pattern);
  }
  return false;
}

function valueMatches(proof: RuleProof, observation: Observation): boolean {
  if (proof.kind !== observation.kind) {
    return false;
  }
  switch (proof.kind) {
    case "command":
      // why the same phrase rule as the trigger: the operator wrote words in an order, in both places.
      return matchesPhrase(observation.value.split(/\s+/), proof.value);
    case "file":
      return pathMatches(proof.value, observation.value);
    default:
      return observation.value === proof.value;
  }
}

/**
 * invariant: `since HEAD` needs a sha on both sides. When the project is not a git checkout there is no HEAD to
 * compare, so a `since HEAD` proof cannot be satisfied — and saying so is the honest answer, rather than treating
 * "no sha" as "any sha".
 */
function windowMatches(proof: RuleProof, observation: Observation, context: ProofContext): boolean {
  if (proof.since === "session") {
    return observation.sessionKey === context.sessionKey;
  }
  return context.sha !== null && observation.sha === context.sha;
}

export function proofSatisfied(
  proof: RuleProof,
  observations: readonly Observation[],
  context: ProofContext,
): boolean {
  return observations.some(
    (observation) => valueMatches(proof, observation) && windowMatches(proof, observation, context),
  );
}

/** invariant: every proof must hold. The list is a conjunction, which is why there is no boolean algebra. */
export function missingProofs(
  rule: Rule,
  observations: readonly Observation[],
  context: ProofContext,
): RuleProof[] {
  return rule.require.filter((proof) => !proofSatisfied(proof, observations, context));
}

export function proofLabel(proof: RuleProof): string {
  return `${proof.kind}(${proof.value}) since ${proof.since === "head" ? "HEAD" : "session"}`;
}

/**
 * What `doctor` needs to tell an operator that a rule can never be satisfied here.
 *
 * why this rather than a capability flag: both hosts report subagent types today, so a flag for it would be a flag
 * that is never false — the shape of a rail that reads as protection and measures nothing
 * ([/decisions/ad-034.md](/decisions/ad-034.md)). What is worth saying is factual: this rule wants a kind of
 * observation that has never been recorded in this project.
 */
export function unobservedKinds(
  rules: readonly Rule[],
  observations: readonly Observation[],
): Array<{ rule: string; kinds: RuleProof["kind"][] }> {
  const seen = new Set(observations.map((observation) => observation.kind));
  return rules
    .map((rule) => ({
      rule: rule.name,
      kinds: [...new Set(rule.require.map((proof) => proof.kind))].filter((kind) => !seen.has(kind)),
    }))
    .filter((entry) => entry.kinds.length > 0);
}
