import type { FailureCategory, GateGap } from "../gate/gate.types.ts";

export function classifyGateFailure(gate: string): FailureCategory {
  if (gate === "lint" || gate === "test" || gate === "comments") {
    return "verification";
  }
  if (gate === "ship" || gate === "empty-diff") {
    return "ship-evidence";
  }
  if (gate === "stagnation") {
    return "stagnation";
  }
  if (gate === "budget") {
    return "budget";
  }
  if (gate === "policy" || gate === "shell-stall") {
    return "policy";
  }
  return "agent-quality";
}

export function suggestionFor(category: FailureCategory, gate: string): string {
  switch (category) {
    case "verification":
      return `Fix the ${gate} findings without suppressions or deleted tests; re-run until the gate passes.`;
    case "stagnation":
      return "Change approach — do not repeat the same failing edit. Inspect root cause or escalate with BLOCKED/TRIED/NEED.";
    case "ship-evidence":
      return "Produce real evidence (or make a real diff) before claiming done/shipped.";
    case "policy":
      return "Respect harness policy (models, shell, explore read-only). Adjust config only if the owner asked.";
    case "budget":
      return "Keep working on the task — do not summarize or end the turn early.";
    case "config":
      return "Check .tlc/harness/config.json commands/paths; run harness doctor.";
    default:
      return "Fix the reported issue and continue; do not invent success.";
  }
}

export function buildGaps(args: {
  gate: string;
  output: string;
  category: FailureCategory;
  max?: number;
}): GateGap[] {
  const max = args.max ?? 8;
  const lines = args.output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(">"));
  const picked = lines.slice(-max);
  if (picked.length === 0) {
    return [
      {
        id: `${args.gate}-0`,
        gate: args.gate,
        category: args.category,
        summary: `${args.gate} failed`,
      },
    ];
  }
  return picked.map((line, index) => ({
    id: `${args.gate}-${index}`,
    gate: args.gate,
    category: args.category,
    summary: line.slice(0, 200),
    detail: line.length > 200 ? line.slice(0, 500) : undefined,
  }));
}

export function formatGapFeedback(gaps: GateGap[], suggestion: string): string {
  const body = gaps.map((g, i) => `${i + 1}. [${g.gate}/${g.category}] ${g.summary}`).join("\n");
  return ["PREVIOUS_GAPS (fix these explicitly — do not ignore):", body, "", `NEXT: ${suggestion}`].join(
    "\n",
  );
}

export const CARRIED_GAP_LIMIT = 5;

/**
 * why: `intelligence.progressiveHandoff` promised to carry gaps into the next session bootstrap, and nothing read
 * the flag. `stop` wrote `previous_gaps` onto the handoff and `session.start` read `blockers` and `next_action`
 * back out but never the gaps, so a resumed session started blind to the gate that was failing when the previous
 * one ended — the one thing the handoff existed to carry.
 *
 * invariant: past tense, and named as the state the previous session ended in rather than as a list to fix now.
 * The gate may already pass; only the next run of it says so, and the same list phrased as an order would send
 * the turn to edit code on the strength of a stale verdict ([/decisions/ad-028.md](/decisions/ad-028.md)).
 */
export function formatCarriedGaps(gaps: readonly GateGap[], limit = CARRIED_GAP_LIMIT): string {
  if (gaps.length === 0) {
    return "";
  }
  const shown = gaps.slice(0, limit);
  const lines = [
    "Gaps open when the previous session ended (history, not a task list — run the gate to see what still holds):",
    ...shown.map((gap, index) => `${index + 1}. [${gap.gate}/${gap.category}] ${gap.summary}`),
  ];
  const dropped = gaps.length - shown.length;
  if (dropped > 0) {
    lines.push(`(${dropped} more not shown — \`tlc harness handoff\` lists all of them.)`);
  }
  return lines.join("\n");
}

export function mergeGaps(prior: GateGap[] | undefined, current: GateGap[], max = 12): GateGap[] {
  const seen = new Set<string>();
  const out: GateGap[] = [];
  for (const gap of [...(prior ?? []), ...current]) {
    const key = `${gap.gate}|${gap.summary}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(gap);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

export function formatProgressiveContext(args: {
  loopCount: number;
  maxLoops: number;
  gate: string;
  category: FailureCategory;
  gaps: GateGap[];
  gateOutput: string;
  suggestion: string;
}): string {
  const attempt = args.loopCount + 1;
  const level = args.loopCount <= 0 ? 1 : args.loopCount === 1 ? 2 : 3;
  const parts: string[] = [
    `PROGRESSIVE_CONTEXT level=${level} attempt=${attempt}/${args.maxLoops} gate=${args.gate} category=${args.category}`,
  ];

  if (level >= 2) {
    parts.push(
      "PRIOR ATTEMPT FAILED — do not repeat the same fix. The gaps below include earlier failures; address all of them.",
    );
  }
  if (level >= 3) {
    parts.push(
      "ESCALATION: two+ stop loops without clearance. Change strategy (different files, smaller patch, or BLOCKED/TRIED/NEED). Do not re-apply the last failing edit.",
    );
  }

  const gapLimit = level === 1 ? 6 : level === 2 ? 10 : 12;
  const outputLines = level === 1 ? 40 : level === 2 ? 80 : 120;
  const trimmedGaps = args.gaps.slice(0, gapLimit);
  parts.push("", formatGapFeedback(trimmedGaps, args.suggestion));

  const rawLines = args.gateOutput.split("\n");
  const outputSlice = rawLines.slice(-outputLines).join("\n").trim();
  if (outputSlice) {
    parts.push("", `GATE_OUTPUT (truncated for level ${level}):`, outputSlice);
  }

  return parts.join("\n");
}
