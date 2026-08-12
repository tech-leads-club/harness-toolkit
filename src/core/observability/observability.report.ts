import { type Row, render, type Screen } from "../../platform/screen.ts";
import { PLAIN, type Style } from "../../platform/style.ts";
import type { SessionRollup } from "./observability.store.ts";
import type { ObsEvent } from "./observability.types.ts";

export type ProviderTotals = {
  provider: string;
  events: number;
  signals: number;
  denials: number;
  gates: { pass: number; fail: number };
  estimated_cost_usd: number;
};

function emptyTotals(provider: string): ProviderTotals {
  return { provider, events: 0, signals: 0, denials: 0, gates: { pass: 0, fail: 0 }, estimated_cost_usd: 0 };
}

export function groupByProvider(events: ObsEvent[]): Record<string, ProviderTotals> {
  const groups: Record<string, ProviderTotals> = {};
  for (const event of events) {
    const totals = groups[event.provider] ?? emptyTotals(event.provider);
    totals.events += 1;
    if (event.level === "signal") {
      totals.signals += 1;
    }
    if (event.kind === "policy.deny") {
      totals.denials += 1;
    }
    if (event.kind === "gate.outcome") {
      if (event.attrs.passed) {
        totals.gates.pass += 1;
      } else {
        totals.gates.fail += 1;
      }
    }
    if (typeof event.gen_ai?.cost_usd === "number") {
      totals.estimated_cost_usd += event.gen_ai.cost_usd;
    }
    groups[event.provider] = totals;
  }
  return groups;
}

/**
 * why: the count alone is not actionable — "seven interruptions" names no switch. The breakdown renders only when
 * there is something in it, so a session that was never interrupted reads exactly as it did before.
 *
 * invariant: this reports the decisions the harness made. It does not know the operator's answer, and it cannot
 * know whether a question it never asked would have helped — so it is a rate and an attribution, never a
 * precision or a recall. Naming it after a metric it cannot compute is the class of claim this project keeps
 * removing ([/decisions/ad-026.md](/decisions/ad-026.md)).
 */
function interruptionsByRule(rollup: SessionRollup): string {
  const entries = Object.entries(rollup.shell.byRule ?? {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return "";
  }
  return entries.map(([rule, count]) => `| ↳ ${rule} | ${count} |`).join("\n");
}

/**
 * why: the question that decides something. A rail that never fired across a session is either working perfectly
 * or was never needed, and either way it is paying for injected prose on every turn. Naming it is what makes
 * deletion a decision instead of a feeling ([/decisions/ad-027.md](/decisions/ad-027.md)).
 *
 * invariant: the active list is a parameter. Core cannot see which rails a project enabled without reading policy,
 * and a report that guessed the list would accuse a rail that was never switched on.
 */
export function railsNeverFired(rollup: SessionRollup, activeRules: readonly string[]): string[] {
  const fired = new Set(Object.keys(rollup.railsByRule ?? {}));
  return activeRules.filter((rule) => !fired.has(rule)).sort();
}

/**
 * hazard: one line said `injected_chars` was "the price of the rails above, paid on every turn". On a host that
 * drops context returned from its session-start hook it is paid never, and the durable rules file — which asks to be
 * included on every request — was absent from the rollup entirely. The number was wrong in both directions there
 * ([/decisions/ad-050.md](/decisions/ad-050.md)).
 *
 * invariant: every number here was observed. The characters are counted from what the harness emitted and from the
 * file it wrote; what the host then does with either is stated as the host's declaration, not as a measurement.
 */
export function costLines(rollup: SessionRollup): string[] {
  if (rollup.injected_chars === 0 && rollup.durable_chars === 0) {
    return [];
  }
  // why: its own section rather than a trailing line under the rails table, which is where it was — so a session
  // with no active rail reported no cost while still paying one.
  const lines = ["", "## Injected context", ""];
  if (rollup.hook_context_reliable) {
    lines.push(
      `Injected at session start: ${rollup.injected_chars} characters. That is the price of the rails, paid on every turn.`,
    );
  } else {
    lines.push(
      `Emitted at session start: ${rollup.injected_chars} characters — this provider does not deliver context returned from that hook, so it is not what the model reads.`,
    );
  }
  if (rollup.durable_chars > 0) {
    lines.push(
      `Durable lessons view: ${rollup.durable_chars} characters, written as an always-applied rules file. That is what the provider is asked to include on every request.`,
    );
  }
  return lines;
}

function railActivity(rollup: SessionRollup, activeRules: readonly string[]): string {
  const fired = Object.entries(rollup.railsByRule ?? {}).sort((a, b) => b[1] - a[1]);
  const silent = railsNeverFired(rollup, activeRules);
  if (fired.length === 0 && silent.length === 0) {
    return "";
  }
  const rows = [
    "",
    "## Rails",
    "",
    "| Rule | Fired |",
    "|------|-------|",
    ...fired.map(([rule, count]) => `| ${rule} | ${count} |`),
    ...silent.map((rule) => `| ${rule} | 0 — enabled and never fired |`),
  ];
  return rows.join("\n");
}

function gateDetail(rollup: SessionRollup): string {
  const entries = Object.entries(rollup.gatesByName ?? {}).sort((a, b) => b[1].fail - a[1].fail);
  if (entries.length === 0) {
    return "";
  }
  return entries.map(([gate, s]) => `| ↳ ${gate} | ${s.pass} / ${s.fail} |`).join("\n");
}

/**
 * why: the question an operator actually asks when a turn takes thirty minutes. The runs column is what makes the
 * multiplication visible: the gate cost is paid once per attempt, so six runs of a four-minute suite is the answer
 * and no amount of hook tuning would have changed it ([/decisions/ad-033.md](/decisions/ad-033.md)).
 */
function gateTimeSection(rollup: SessionRollup): string {
  const entries = Object.entries(rollup.gateTime ?? {}).sort((a, b) => b[1].totalMs - a[1].totalMs);
  if (entries.length === 0) {
    return "";
  }
  const seconds = (ms: number): string => (ms / 1000).toFixed(1);
  return [
    "",
    "## Gate time",
    "",
    "| Gate | Runs | Reused | Total s | Worst run s |",
    "|------|------|--------|---------|-------------|",
    ...entries.map(
      ([gate, t]) =>
        `| ${gate} | ${t.runs} | ${t.reused ?? 0} | ${seconds(t.totalMs)} | ${seconds(t.worstMs)} |`,
    ),
    "",
    "A gate's cost is paid once per attempt, so the total is the command's own time multiplied by how many times the",
    "agent had to retry. Lowering it means a faster command or fewer failures, not a faster harness.",
    "",
    "**Reused** is a stop where nothing the gate reads had changed, so the previous verdict stood and the command did",
    "not run. Those are the runs the harness did not make you pay for.",
  ].join("\n");
}

export function sessionReportMarkdown(rollup: SessionRollup, activeRules: readonly string[] = []): string {
  const models = Object.entries(rollup.models)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `| ${m} | ${n} |`)
    .join("\n");
  const tools = Object.entries(rollup.tools)
    .sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail))
    .map(([t, s]) => `| ${t} | ${s.ok} | ${s.fail} | ${Math.round(s.ms)} |`)
    .join("\n");
  const subs = Object.entries(rollup.subagents)
    .map(([t, s]) => `| ${t} | ${s.count} | ${JSON.stringify(s.models)} |`)
    .join("\n");
  const costLabel = rollup.cost_incomplete
    ? `${rollup.estimated_cost_usd.toFixed(4)} (incomplete — some models lacked catalog rates)`
    : rollup.estimated_cost_usd.toFixed(4);

  return `# Harness session report

**Provider:** \`${rollup.provider}\`
**Session:** \`${rollup.session_id}\`
**Started:** ${rollup.started_at}
**Updated:** ${rollup.updated_at}

## Cost / tokens (estimated)

| Metric | Value |
|--------|-------|
| Estimated USD | ${costLabel} |
| Input tokens | ${rollup.input_tokens} |
| Output tokens | ${rollup.output_tokens} |
| Cost alert sent | ${rollup.cost_alert_sent} |

## Activity

| Metric | Value |
|--------|-------|
| Prompts | ${rollup.prompts} |
| Responses | ${rollup.responses} |
| Thoughts | ${rollup.thoughts} |
| Compactions | ${rollup.comped} |
| Policy denials | ${rollup.denials} |
| Gates pass/fail | ${rollup.gates.pass} / ${rollup.gates.fail} |
${gateDetail(rollup)}
| Shell allow/ask/deny | ${rollup.shell.allow} / ${rollup.shell.ask} / ${rollup.shell.deny} |
${interruptionsByRule(rollup)}

## Models

| Model | Events |
|-------|--------|
${models || "| — | 0 |"}

## Tools

| Tool | OK | Fail | ms |
|------|----|------|----|
${tools || "| — | 0 | 0 | 0 |"}

## Subagents

| Type | Count | Models |
|------|-------|--------|
${subs || "| — | 0 | {} |"}

## MCP tools

\`\`\`json
${JSON.stringify(rollup.mcp, null, 2)}
\`\`\`
${gateTimeSection(rollup)}
${railActivity(rollup, activeRules)}
${costLines(rollup).join("\n")}
`;
}

// why: the markdown is an artifact — written to a file and pasted into a pull request — so it stays plain. The
// terminal gets its own shape over the same rollup, because colouring one string for both would put escapes in
// the file ([/decisions/ad-063.md](/decisions/ad-063.md)).
/** The tools whose successes are recorded as shell events, so the tools table can never count them. */
export const SHELL_TOOLS = new Set(["Bash", "run_terminal_cmd", "terminal"]);

export function sessionReportScreen(rollup: SessionRollup): Screen {
  const top = (counts: Record<string, number>, limit = 6): string[] =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => `${name} ${count}`);

  const costLabel = rollup.cost_incomplete
    ? `$${rollup.estimated_cost_usd.toFixed(4)} (incomplete — some models lacked catalog rates)`
    : `$${rollup.estimated_cost_usd.toFixed(4)}`;

  const shell = rollup.shell;
  // hazard: `rollup.tools` is fed only by `tool.start|end|fail`. A successful shell call is `shell.end` and a
  // failed one is `tool.fail`, so a shell tool's row can only ever show failures — it read `Bash: 0 ok, 23 fail`
  // after hundreds of successful calls. The `shell` row above already answers for it, correctly
  // ([/decisions/ad-064.md](/decisions/ad-064.md)).
  const toolRows: Row[] = Object.entries(rollup.tools)
    .filter(([tool]) => !SHELL_TOOLS.has(tool))
    .sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail))
    .slice(0, 8)
    .map(([tool, stats]) => ({
      label: tool,
      value: `${stats.ok} ok, ${stats.fail} fail`,
      level: stats.fail > 0 ? ("warn" as const) : ("ok" as const),
    }));

  const ruleRows: Row[] = Object.entries(rollup.shell.byRule ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([rule, count]) => ({ label: rule, value: String(count), level: "warn" as const }));

  return {
    title: "session report",
    summary: [`${rollup.provider}/${rollup.session_id}`, rollup.updated_at],
    sections: [
      {
        title: "Cost",
        rows: [
          { label: "estimated", value: costLabel, level: rollup.cost_incomplete ? "warn" : "info" },
          {
            // why: the reading is the transcript tail's total, not the session's. Labelled for what it is, because
            // "Input tokens" invited the reading that produced 102.7M ([/decisions/ad-064.md](/decisions/ad-064.md)).
            label: "tokens in/out",
            value: `${rollup.input_tokens} / ${rollup.output_tokens} (latest reading, recent transcript only)`,
          },
        ],
      },
      {
        title: "Activity",
        rows: [
          { label: "prompts", value: String(rollup.prompts) },
          {
            label: "gates",
            value: `${rollup.gates.pass} pass / ${rollup.gates.fail} fail`,
            level: rollup.gates.fail > 0 ? "fail" : "ok",
          },
          {
            label: "policy denials",
            value: String(rollup.denials),
            level: rollup.denials > 0 ? "warn" : "ok",
          },
          {
            label: "shell",
            value: `${shell.allow} allow / ${shell.ask} ask / ${shell.deny} deny`,
            level: shell.deny > 0 ? "warn" : "ok",
          },
          { label: "compactions", value: String(rollup.comped) },
        ],
      },
      ...(ruleRows.length > 0 ? [{ title: "Interruptions by rule", rows: ruleRows }] : []),
      ...(toolRows.length > 0 ? [{ title: "Tools", rows: toolRows }] : []),
      ...(Object.keys(rollup.models).length > 0
        ? [{ title: "Models", lines: [top(rollup.models).join("  ·  ")] }]
        : []),
    ],
    footer:
      "tlc harness why for the decisions  ·  --json for the rollup  ·  the markdown copy is under state/reports",
  };
}

export function sessionReportText(rollup: SessionRollup, style: Style = PLAIN): string {
  return render(sessionReportScreen(rollup), style);
}
