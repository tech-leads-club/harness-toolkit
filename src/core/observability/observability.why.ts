import type { ObsEvent } from "./observability.types.ts";

/**
 * why: an operator watching an agent cannot tell a harness decision from model behaviour, because a hook answers
 * the host and the host decides whether to show it. `obs report` is a session rollup and `obs live` is a firehose;
 * neither answers "did the harness just do that?" ([/decisions/ad-062.md](/decisions/ad-062.md)).
 *
 * invariant: derived from the two obs planes and nothing else. A second producer would be a second index, and the
 * planes are already the record of record.
 */
export type HarnessDecision = {
  ts: string;
  /** What the harness was answering — the event kind, or the gate's name. */
  about: string;
  /** What it did: deny, ask, allow, pass, fail, or context. */
  verdict: string;
  /** The rule responsible, or `null` when the record carries none. */
  rule: string | null;
  /** One line of what it was about — a command, a tool, a size. Never the model's words. */
  detail: string;
};

const NONE = new Set(["none", "", "undefined"]);

function attr(event: ObsEvent, name: string): string | undefined {
  const value = (event.attrs as Record<string, unknown> | undefined)?.[name];
  return value === undefined || value === null ? undefined : String(value);
}

function ruleOf(event: ObsEvent): string | null {
  const raw = attr(event, "rule");
  return raw === undefined || NONE.has(raw) ? null : raw;
}

function truncate(text: string | undefined, max = 90): string {
  if (!text) {
    return "";
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * invariant: only records that represent a decision. Everything else in the planes is activity — a turn doing
 * work is not the harness doing something, and listing it would bury the four lines that matter.
 */
export function decisionsFrom(events: readonly ObsEvent[], sessionKey?: string): HarnessDecision[] {
  const out: HarnessDecision[] = [];
  for (const event of events) {
    if (sessionKey !== undefined && event.session_id !== sessionKey) {
      continue;
    }
    if (event.kind === "policy.deny") {
      out.push({
        ts: event.ts,
        about: attr(event, "event") ?? "tool",
        verdict: attr(event, "permission") ?? "deny",
        rule: ruleOf(event),
        detail: truncate(attr(event, "tool_name")),
      });
      continue;
    }
    if (event.kind === "shell.start") {
      out.push({
        ts: event.ts,
        about: "shell",
        verdict: attr(event, "permission") ?? "allow",
        rule: ruleOf(event),
        detail: truncate(attr(event, "command")),
      });
      continue;
    }
    if (event.kind === "gate.outcome") {
      out.push({
        ts: event.ts,
        about: `gate ${attr(event, "gate") ?? "?"}`,
        verdict: attr(event, "passed") === "true" ? "pass" : "fail",
        rule: null,
        detail: truncate(attr(event, "scoped_env") === "none" ? "" : `env: ${attr(event, "scoped_env")}`),
      });
      continue;
    }
    if (event.kind === "session.start") {
      out.push({
        ts: event.ts,
        about: "session start",
        verdict: "context",
        rule: null,
        detail: truncate(`${attr(event, "injected_chars") ?? "0"} chars injected`),
      });
    }
  }
  return out.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? 1 : -1));
}

export const NOTHING_WAS_THE_HARNESS = [
  "No harness decision in this window.",
  "Whatever you just saw was the model, not a rail — the harness allowed everything it was asked about.",
].join("\n");

/**
 * why: the empty case is the feature. "Nothing here was the harness" is the sentence an operator cannot get from
 * any other command, and printing an empty table instead would leave them exactly as unsure as before.
 */
export function whyText(decisions: readonly HarnessDecision[]): string {
  if (decisions.length === 0) {
    return NOTHING_WAS_THE_HARNESS;
  }
  const lines = decisions.map((decision) => {
    const when = decision.ts.slice(11, 19);
    // why: a record written before `rule` was required carries none, and the reading for that is "unattributed"
    // rather than a blank — a blank reads as "no rule applied", which is a different and wrong fact.
    const rule = decision.rule === null ? "rule=unattributed" : `rule=${decision.rule}`;
    const head = `${when}  ${decision.about.padEnd(14)} ${decision.verdict.padEnd(7)} ${rule}`.trimEnd();
    return decision.detail ? `${head}\n${" ".repeat(10)}${decision.detail}` : head;
  });
  return [`Last ${decisions.length} harness decision(s), newest first:`, "", ...lines].join("\n");
}
