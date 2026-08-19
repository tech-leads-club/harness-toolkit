import type { OperatorMode, Policy } from "./policy.types.ts";

const BASE = [
  "Harness: drive tasks to verified completion without babysitting the owner.",
  "Evidence or stop: no invented numbers, versions, or PASS claims. Cite paths, command output, or evidence files.",
  "Otherwise assume the sensible default, proceed, and state the assumption in one line.",
  "Verification does not change with posture: the same evidence bar, the same gates, the same done-criteria at every level. What changes is how much you surface and what earns an interruption.",
  "Before calling done: build, tests and lint must pass; no deleted tests; diff size matches the ask; the result matches the full request.",
  "If blocked, use exactly: BLOCKED / TRIED / NEED — one tight block, no preamble.",
];

// hazard: the interruption threshold used to live in BASE — as solo's, asserted for all three — and each
// posture line then contradicted it. `paired` promised a pre-check while BASE said to ask for three things
// only; the deepest posture said not to ask about reversible work while BASE still demanded escalating
// ambiguity. A varying rule cannot sit in the invariant block, so it moved here and is stated once.
// invariant: no posture line names a gate, a capability or a config field. The old solo line named the ship
// gate and the old deepest line named grind — both machinery, and machinery is what must not vary by posture.
/**
 * hazard: every line here used to state a threshold and no deadline, which licensed the worst case — asking at
 * the twentieth action about a goal misread at the first. Measured across models and benchmarks: a question
 * about the goal loses nearly all its value once the work is under way, and asking late is worse than never
 * having asked ([/decisions/ad-026.md](/decisions/ad-026.md)). So each line now says *when* as well as *what*.
 *
 * invariant: no line names a percentage or a count of turns. The harness cannot measure where in a trajectory it
 * is, and a number it cannot compute is a claim it cannot honour.
 */
const BY_POSTURE: Record<OperatorMode, string> = {
  paired:
    "Posture paired: show your reasoning as you go, and check in before any sizable non-destructive move. Surface an irreversible action, a real dead-end after exhausting sources, and ambiguity that changes the outcome. Raise an unclear goal in your first actions, before you have built anything on your reading of it.",
  solo: "Posture solo: work on your own. Surface exactly three things — an irreversible or destructive action, a real dead-end after exhausting sources, and ambiguity that changes the outcome. An unclear goal belongs in your first actions; once the work is under way, asking costs more than deciding, so take the most reasonable reading and state the assumption in one line instead.",
  focus:
    "Posture focus: deepest autonomy, fewest interruptions. Only an irreversible or destructive action and a real dead-end reach the operator. The one exception is a goal you cannot read before you start — ask that once, up front, because it is cheaper than everything you would build on a misreading. After that, ambiguity is yours to settle by taking the most reasonable reading and stating the assumption in one line.",
};

export function operatorBootstrapLines(policy: Policy, stateDir: string): string[] {
  // why: the command, and the path only as where it lands. Naming the file as the route asked the agent for an
  // action the floor refuses, and the refusal then gave advice about writing policy
  // ([/decisions/ad-047.md](/decisions/ad-047.md)).
  const lines = [
    ...BASE,
    `State is held between turns and sessions at ${stateDir}/handoff.json — read it with \`tlc harness handoff\`, and let the harness write it.`,
  ];
  lines.push(BY_POSTURE[policy.mode]);

  if (policy.shipGate.enabled) {
    lines.push(
      "Ship protocol: the ship gate reacts only to an explicit line `HARNESS_SHIP_CLAIM: <summary>` — free-English done or shipped is ignored. After that claim, cite recent PASS evidence under the configured evidenceDir before stopping.",
    );
  }
  if (policy.comments.enabled) {
    lines.push(
      policy.comments.mode === "strict"
        ? "Comments: do not add any. If one is warranted, say so in your reply and let the owner write it."
        : policy.comments.mode === "resolvable"
          ? "Comments: an added comment must declare why:, hazard: or invariant:, and must read for someone who was not in this session. Do not narrate the change (used to, previously, this was), cite a plan, decision number or section only this session saw, speak from the change (this PR, a later commit), or argue your own correctness. State the present behaviour, or the counterfactual: without X, Y happens."
          : "Comments: an added comment must declare why:, hazard: or invariant:. Narrating what the code does is blocked.",
    );
  }
  if (policy.supplyChain.enabled) {
    lines.push(
      "Dependencies: when you add one, pin a version and commit the lockfile in the same turn — the gate blocks a stop on a manifest that moved without its lockfile, or a specifier of latest/*/no version. If a floating specifier is deliberate, say which and why in one line.",
    );
  }
  if (policy.duplication.enabled) {
    lines.push(
      "Duplication: before writing a block, check whether the project already has it — the gate blocks a stop when this turn added six or more lines that exist elsewhere. Call the existing code or extract what both need. If two copies are deliberate, say which in one line.",
    );
  }
  if (policy.mcpPrime.length > 0) {
    lines.push("", "MCP prime (before host grep or glob across the workspace):");
    for (const [index, step] of policy.mcpPrime.entries()) {
      lines.push(`${index + 1}. ${step}`);
    }
  }
  lines.push(...policy.bootstrapExtra);
  return lines;
}
