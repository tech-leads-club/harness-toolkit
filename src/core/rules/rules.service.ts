/**
 * The composition the entrypoints call: read the rules, see what fired, decide.
 *
 * why here and not in the entrypoint: the entrypoints are adapters. Which rules apply, what proves them and what
 * the verdict is are all decisions, and decisions live in core ([/decisions/ad-016.md](/decisions/ad-016.md)).
 *
 * invariant: with the capability off, or with no rule files, this reads two directory entries and returns nothing.
 * That is what makes the feature inert until an operator declares something (AC1).
 */
import type { Decision } from "../../contracts/decision.ts";
import type { OperatorMode } from "../policy/policy.types.ts";
import { actionDecision, evaluateRules, type RuleOutcome, strictest } from "./rules.decide.ts";
import { type ObservableEvent, type ObserveContext, observationFrom } from "./rules.observe.ts";
import { buildRuleSet } from "./rules.parse.ts";
import { readObservations, readRuleSources, recordObservation } from "./rules.store.ts";
import { firingRules, type TriggerContext } from "./rules.trigger.ts";
import type { RuleError, RuleSet } from "./rules.types.ts";

export type RulesConfig = { enabled: boolean };

export function loadRules(root: string, config: RulesConfig): RuleSet {
  if (!config.enabled) {
    return { rules: [], disabled: [], errors: [] };
  }
  return buildRuleSet(readRuleSources(root));
}

/**
 * invariant: recorded only when a rule could ever want it. With the capability off nothing is written, so a
 * machine that never opted in carries no new file and pays no cost.
 */
export function observe(
  root: string,
  config: RulesConfig,
  event: ObservableEvent,
  context: ObserveContext,
): void {
  if (!config.enabled) {
    return;
  }
  const observation = observationFrom(event, context);
  if (observation !== null) {
    recordObservation(root, observation);
  }
}

export type RulesVerdict = {
  decision: Decision;
  /** Everything that fired, so a `follow-up` or a `warn` can be reported even when the action is allowed. */
  outcomes: RuleOutcome[];
  errors: RuleError[];
};

const NOTHING: RulesVerdict = { decision: { kind: "abstain" }, outcomes: [], errors: [] };

/**
 * The action-time answer. `deny` and `ask` block here; `follow-up` and `warn` are answers to the end of a turn and
 * to the record, so they abstain and are returned for the caller to report.
 */
export function decideAction(
  root: string,
  config: RulesConfig,
  trigger: TriggerContext,
  context: { sha: string | null; sessionKey: string; mode: OperatorMode },
): RulesVerdict {
  const set = loadRules(root, config);
  if (set.rules.length === 0 && set.errors.length === 0) {
    return NOTHING;
  }
  const firing = firingRules(set.rules, trigger);
  if (firing.length === 0) {
    return { ...NOTHING, errors: set.errors };
  }
  const outcomes = evaluateRules(firing, readObservations(root), context);
  const worst = strictest(outcomes);
  return {
    decision: worst === null ? { kind: "abstain" } : actionDecision(worst),
    outcomes,
    errors: set.errors,
  };
}
