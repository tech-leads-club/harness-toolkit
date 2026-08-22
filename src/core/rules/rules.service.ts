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
import { actionDecision, evaluateRules, type RuleOutcome, stopDecision, strictest } from "./rules.decide.ts";
import {
  gateObservation,
  type ObservableEvent,
  type ObserveContext,
  observationFrom,
  observedFact,
  resolveSpawnType,
  spawnLinkFrom,
} from "./rules.observe.ts";
import { buildRuleSet } from "./rules.parse.ts";
import { kindIsRequired } from "./rules.proof.ts";
import {
  readObservations,
  readRuleSources,
  readSpawnLinks,
  recordObservation,
  recordSpawnLink,
} from "./rules.store.ts";
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
 * Whether this event is worth a sha.
 *
 * hazard: nothing called `observe` at all in the first cut of this feature. The store was never written, so no
 * proof could exist, so every rule that parsed denied for ever — and `require:` is mandatory, so that was every
 * rule. The end-to-end run that appeared to show the loop working was a script calling `observe` by hand, which
 * supplied the missing half and hid it ([/decisions/ad-100.md](/decisions/ad-100.md)).
 *
 * why the question is asked before the answer is fetched: the observing rails fire on every tool call and the sha
 * is a process spawn. An operator whose only rule wants `subagent(the-jury)` pays two directory reads per command
 * and no git at all.
 */
export function wantsObservation(root: string, config: RulesConfig, event: ObservableEvent): boolean {
  const rules = loadRules(root, config).rules;
  // why the spawn counts as wanted: the link it leaves is what makes the stop resolvable, so a rule asking for
  // subagent proof has to make the spawn worth observing too ([/decisions/ad-104.md](/decisions/ad-104.md)).
  if (spawnLinkFrom(event) !== null) {
    return kindIsRequired(rules, "subagent");
  }
  const fact = observedFact(event);
  return fact !== null && kindIsRequired(rules, fact.kind);
}

/** invariant: with the capability off nothing is written, so a machine that never opted in carries no new file. */
export function observe(
  root: string,
  config: RulesConfig,
  event: ObservableEvent,
  context: ObserveContext,
): void {
  if (!config.enabled) {
    return;
  }
  const link = spawnLinkFrom(event);
  if (link !== null) {
    recordSpawnLink(root, { ...link, at: context.at });
    return;
  }
  const observation = observationFrom(
    resolveSpawnType(event, () => readSpawnLinks(root)),
    context,
  );
  if (observation !== null) {
    recordObservation(root, observation);
  }
}

/**
 * A gate is the one proof the harness decides rather than witnesses, so it is recorded where it is decided.
 *
 * invariant: only a gate that passed. Recording a failure as an observation would make "the gate ran" satisfy a
 * rule that asked for "the gate passed".
 */
export function wantsGateObservation(root: string, config: RulesConfig): boolean {
  return kindIsRequired(loadRules(root, config).rules, "gate");
}

export function observeGate(root: string, config: RulesConfig, gate: string, context: ObserveContext): void {
  if (!config.enabled) {
    return;
  }
  recordObservation(root, gateObservation(gate, context));
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
  context: RuleContext,
): RulesVerdict {
  return decide(root, config, trigger, context, actionDecision);
}

/**
 * The end-of-turn answer, and the only caller that can see an `on: stop` rule.
 *
 * why a second entry rather than a flag: the trigger is fixed and the mapping differs, so a boolean would make one
 * function answer two questions ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
export function decideStop(root: string, config: RulesConfig, context: RuleContext): RulesVerdict {
  return decide(root, config, { event: "stop" }, context, stopDecision);
}

export type RuleContext = { sha: string | null; sessionKey: string; mode: OperatorMode };

function decide(
  root: string,
  config: RulesConfig,
  trigger: TriggerContext,
  context: RuleContext,
  map: (outcome: RuleOutcome) => Decision,
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
    decision: worst === null ? { kind: "abstain" } : map(worst),
    outcomes,
    errors: set.errors,
  };
}
