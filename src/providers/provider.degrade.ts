import type { Decision, HarnessEvent, ProviderCapabilities } from "../contracts/index.ts";

export type DegradeOptions = {
  /** Character budget for `context` text. Undefined means no truncation. */
  contextBudgetChars?: number;
};

/**
 * why: the only rule this layer may name. Every other decision arrives with its rule already set by the rail that
 * made it, and degrade preserves it ([/decisions/ad-061.md](/decisions/ad-061.md)).
 */
export const DEGRADE_RULES = { rewriteUnavailable: "rewrite-unavailable" } as const;

const ESCALATION_PREFIX = "Escalation unavailable on this provider — ";
const NO_HUMAN_PREFIX = "No operator is answering prompts in this permission mode — ";

// hazard: these modes exist to stop prompting the operator, so an `ask` raised under them reaches
// nobody. Whether the provider drops it or silently allows the call is undocumented, and a gate
// whose outcome depends on undocumented behaviour is not a gate — deny and say why instead.
const NO_HUMAN_MODES = new Set(["bypassPermissions", "dontAsk"]);
const ADVISORY_PREFIX = "ADVISORY — this provider cannot enforce: ";
const TRUNCATION_MARKER = "\n…(truncated — over context budget)";

function isEnforcing(decision: Decision): boolean {
  return (
    decision.kind === "deny" ||
    decision.kind === "ask" ||
    decision.kind === "continue" ||
    decision.kind === "rewriteInput"
  );
}

function describeDecision(decision: Decision): string {
  switch (decision.kind) {
    case "deny":
    case "ask":
      return decision.reason;
    case "continue":
      return decision.text;
    case "rewriteInput":
      return `${decision.reason} (proposed input: ${JSON.stringify(decision.input)})`;
    default:
      return "";
  }
}

export function truncateContext(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) {
    return text;
  }
  if (budgetChars <= 0) {
    return "";
  }
  const marker =
    TRUNCATION_MARKER.length <= budgetChars ? TRUNCATION_MARKER : TRUNCATION_MARKER.slice(0, budgetChars);
  const keep = Math.max(0, budgetChars - marker.length);
  return `${text.slice(0, keep)}${marker}`;
}

function canCarryContext(event: HarnessEvent, capabilities: ProviderCapabilities): boolean {
  if (event.event === "tool.before") {
    return capabilities.contextAtToolBefore;
  }
  if (event.event === "tool.after") {
    return capabilities.contextAtToolAfter;
  }
  // hazard: the docs gate raises an advisory here. Cursor's `stop` schema carries `followup_message` and nothing
  // else, so the advisory was rendered into `additional_context` and read by no one. `followup_message` is not the
  // fallback — it auto-submits, and the advisory says in its own words that it does not block the stop.
  if (event.event === "stop") {
    return capabilities.contextAtStop;
  }
  // why: `session.start` stays true even where the host loses the text. Cursor's drop is a race rather than a
  // refusal, so the emission is free when lost and delivered when won — the durable view is the second route,
  // not the replacement ([/decisions/ad-050.md](/decisions/ad-050.md)).
  return true;
}

function applyContextBudget(decision: Decision, budgetChars: number | undefined): Decision {
  if (decision.kind !== "context" || budgetChars === undefined) {
    return decision;
  }
  const truncated = truncateContext(decision.text, budgetChars);
  if (truncated === decision.text) {
    return decision;
  }
  return { ...decision, text: truncated };
}

export function degrade(
  decision: Decision,
  event: HarnessEvent,
  capabilities: ProviderCapabilities,
  options: DegradeOptions = {},
): Decision {
  if (!capabilities.enforcesHooks && isEnforcing(decision)) {
    return applyContextBudget(
      { kind: "context", text: `${ADVISORY_PREFIX}${describeDecision(decision)}` },
      options.contextBudgetChars,
    );
  }

  if (decision.kind === "ask") {
    if (!capabilities.askSupportedOn.includes(event.event)) {
      // invariant: the rule is carried through, never replaced. This is the one place a decision changes shape,
      // so it is the case an operator most needs attributed — and inventing a rule here would attribute a refusal
      // to the transport rather than to the rail that made it ([/decisions/ad-061.md](/decisions/ad-061.md)).
      return {
        kind: "deny",
        reason: `${ESCALATION_PREFIX}${decision.reason}`,
        userNote: decision.userNote,
        rule: decision.rule,
      };
    }
    if (event.permissionMode !== undefined && NO_HUMAN_MODES.has(event.permissionMode)) {
      return {
        kind: "deny",
        reason: `${NO_HUMAN_PREFIX}${decision.reason}`,
        userNote: decision.userNote,
        rule: decision.rule,
      };
    }
    return decision;
  }

  if (decision.kind === "rewriteInput" && !capabilities.toolInputRewrite) {
    return {
      kind: "ask",
      reason: `Input rewrite unavailable on this provider — proposed input: ${JSON.stringify(decision.input)}. ${decision.reason}`,
      // why: a rewrite carries no rule of its own — nothing refused anything — so the degraded ask names the
      // transport limit that produced it. It is the one rule this layer owns.
      rule: DEGRADE_RULES.rewriteUnavailable,
    };
  }

  if (decision.kind === "context") {
    // hazard: contextAtToolBefore and contextAtToolAfter were declared by every adapter and read by
    // nothing. A provider that cannot carry context on the current event would have had the text rendered
    // into a field it ignores, leaving the caller believing it was delivered. Abstaining is the honest
    // answer: context is informative, so there is nothing to escalate to.
    if (!canCarryContext(event, capabilities)) {
      return { kind: "abstain" };
    }
    if (decision.env && !capabilities.sessionEnv) {
      const { env: _droppedEnv, ...withoutEnv } = decision;
      return applyContextBudget(withoutEnv, options.contextBudgetChars);
    }
    return applyContextBudget(decision, options.contextBudgetChars);
  }

  return decision;
}
