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

/**
 * why this exists at all: "missing" reads the same whether the thing never ran or it ran and the window rejected
 * it, and only one of those is a config-side fact worth stating rather than a guess. The fact is cheap and always
 * true — an observation of this kind and value exists — so it is stated whenever it holds
 * ([/decisions/ad-060.md](/decisions/ad-060.md)'s own distinction between a fact and a diagnosis).
 */
function staleReason(proof: RuleProof, context: ProofContext): string {
  if (proof.since === "session") {
    return "ran, but in a different session";
  }
  return context.sha === null
    ? "ran, but this project is not a git checkout, so since HEAD can never be satisfied"
    : "ran, but at a different commit";
}

export type MissingProof = { proof: RuleProof; reason: string | null };

/** invariant: every proof must hold. The list is a conjunction, which is why there is no boolean algebra. */
export function missingProofs(
  rule: Rule,
  observations: readonly Observation[],
  context: ProofContext,
): MissingProof[] {
  return rule.require
    .filter((proof) => !proofSatisfied(proof, observations, context))
    .map((proof) => ({
      proof,
      reason: observations.some((observation) => valueMatches(proof, observation))
        ? staleReason(proof, context)
        : null,
    }));
}

export function proofLabel(missing: MissingProof): string {
  const { proof, reason } = missing;
  const base = `${proof.kind}(${proof.value}) since ${proof.since === "head" ? "HEAD" : "session"}`;
  return reason === null ? base : `${base} (${reason})`;
}

/**
 * Whether recording this kind could ever matter here.
 *
 * why: the observing rails fire on every tool call, and a fact nothing reads is a write and a process spawn for
 * nothing. An operator whose only rule wants `subagent(the-jury)` pays no git on any command
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
export function kindIsRequired(rules: readonly Rule[], kind: RuleProof["kind"]): boolean {
  return rules.some((rule) => rule.require.some((proof) => proof.kind === kind));
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
