import { type ColorName, PLAIN, type Style, SYMBOLS } from "../../platform/style.ts";
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

export type WhySummary = { denied: number; asked: number; allowed: number; other: number };

export function summarise(decisions: readonly HarnessDecision[]): WhySummary {
  const tally = { denied: 0, asked: 0, allowed: 0, other: 0 };
  for (const decision of decisions) {
    if (decision.verdict === "deny") {
      tally.denied += 1;
    } else if (decision.verdict === "ask") {
      tally.asked += 1;
    } else if (decision.verdict === "allow") {
      tally.allowed += 1;
    } else {
      tally.other += 1;
    }
  }
  return tally;
}

/**
 * why: the empty case is the feature. "Nothing here was the harness" is the sentence an operator cannot get from
 * any other command, and printing an empty table instead would leave them exactly as unsure as before.
 */
export function whyText(
  decisions: readonly HarnessDecision[],
  style: Style = PLAIN,
  now = new Date(),
): string {
  if (decisions.length === 0) {
    return [
      style.paint("success", `${SYMBOLS.check} ${NOTHING_WAS_THE_HARNESS.split("\n")[0]}`),
      style.dim(NOTHING_WAS_THE_HARNESS.split("\n")[1] ?? ""),
    ].join("\n");
  }

  const tally = summarise(decisions);
  const today = now.toISOString().slice(0, 10);
  const parts = [
    tally.denied > 0 ? style.paint("error", `${tally.denied} denied`) : "",
    tally.asked > 0 ? style.paint("warning", `${tally.asked} asked`) : "",
    tally.allowed > 0 ? style.paint("success", `${tally.allowed} allowed`) : "",
    tally.other > 0 ? style.dim(`${tally.other} other`) : "",
  ].filter(Boolean);

  const lines = decisions.map((decision) => {
    // why: the date appears only when the record is not from today. Ten identical timestamps with no date was
    // the reading that made the first version unreadable — it looked like one burst and spanned three days.
    const day = decision.ts.slice(0, 10);
    const when = day === today ? decision.ts.slice(11, 19) : `${day} ${decision.ts.slice(11, 19)}`;
    const verdictColor: ColorName =
      decision.verdict === "deny" ? "error" : decision.verdict === "ask" ? "warning" : "success";
    // why: the `rule=` prefix survives because it is what every denial message prints and what the
    // troubleshooting page tells people to grep for. Colour is not available when the output is piped.
    const rule =
      decision.rule === null ? style.dim("rule=unattributed") : style.paint("info", `rule=${decision.rule}`);
    const head = [
      style.dim(when.padEnd(day === today ? 8 : 19)),
      style.paint("textMuted", decision.about.padEnd(14)),
      style.paint(verdictColor, decision.verdict.padEnd(7)),
      rule,
    ].join(" ");
    return decision.detail ? `${head}\n${" ".repeat(4)}${style.dim(SYMBOLS.bar)} ${decision.detail}` : head;
  });

  return [
    style.heading(`LAST ${decisions.length} HARNESS DECISION${decisions.length === 1 ? "" : "S"}`),
    `   ${parts.join(style.dim(` ${SYMBOLS.bar} `))}`,
    "",
    ...lines,
    "",
    style.footer("newest first  ·  tlc harness why 30 widens the window  ·  --json for the records"),
  ].join("\n");
}
