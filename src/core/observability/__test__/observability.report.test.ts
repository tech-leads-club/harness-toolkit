import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { groupByProvider, railsNeverFired, sessionReportMarkdown } from "../observability.report.ts";
import { newRollup } from "../observability.store.ts";
import type { ObsEvent } from "../observability.types.ts";

function makeEvent(overrides: Partial<ObsEvent>): ObsEvent {
  return {
    schema: "harness.observability.v1",
    provider: "provider-a",
    kind: "policy.deny",
    level: "signal",
    ts: new Date().toISOString(),
    trace_id: "trace",
    span_id: "span",
    attrs: {},
    ...overrides,
  };
}

test("a mixed-provider log yields exactly two groups", () => {
  const groups = groupByProvider([
    makeEvent({ provider: "provider-a" }),
    makeEvent({ provider: "provider-a" }),
    makeEvent({ provider: "provider-b" }),
  ]);
  assert.deepEqual(Object.keys(groups).sort(), ["provider-a", "provider-b"]);
  assert.equal(groups["provider-a"]?.events, 2);
  assert.equal(groups["provider-b"]?.events, 1);
});

test("groupByProvider counts policy denials per provider", () => {
  const groups = groupByProvider([
    makeEvent({ provider: "provider-a", kind: "policy.deny" }),
    makeEvent({ provider: "provider-b", kind: "session.start" }),
  ]);
  assert.equal(groups["provider-a"]?.denials, 1);
  assert.equal(groups["provider-b"]?.denials, 0);
});

test("groupByProvider sums estimated cost per provider", () => {
  const groups = groupByProvider([
    makeEvent({ provider: "provider-a", gen_ai: { cost_usd: 0.1 } }),
    makeEvent({ provider: "provider-a", gen_ai: { cost_usd: 0.2 } }),
  ]);
  assert.ok(Math.abs((groups["provider-a"]?.estimated_cost_usd ?? 0) - 0.3) < 1e-9);
});

test("groupByProvider on an empty log returns no groups", () => {
  assert.deepEqual(groupByProvider([]), {});
});

test("sessionReportMarkdown names the owning provider and session", () => {
  const rollup = newRollup("session-a", "provider-a");
  const markdown = sessionReportMarkdown(rollup);
  assert.ok(markdown.includes("provider-a"));
  assert.ok(markdown.includes("session-a"));
});

test("sessionReportMarkdown flags an incomplete cost estimate", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.cost_incomplete = true;
  const markdown = sessionReportMarkdown(rollup);
  assert.ok(markdown.includes("incomplete"));
});

// why: a count without an attribution names no switch. Six asks from the paired posture and one from the
// catastrophic rule call for two different responses, and "7" calls for neither.
test("sessionReportMarkdown attributes the interruptions to their rules", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.shell.ask = 7;
  rollup.shell.byRule = { "shell-posture-paired": 6, "shell-catastrophic": 1 };
  const markdown = sessionReportMarkdown(rollup);
  assert.match(markdown, /shell-posture-paired \| 6/);
  assert.match(markdown, /shell-catastrophic \| 1/);
  // why: ordered by weight, so the rule doing the interrupting is the first thing read.
  assert.ok(
    markdown.indexOf("shell-posture-paired") < markdown.indexOf("shell-catastrophic"),
    "the breakdown is not ordered by count",
  );
});

test("a session with no interruptions renders no breakdown", () => {
  const markdown = sessionReportMarkdown(newRollup("session-a", "provider-a"));
  assert.doesNotMatch(markdown, /↳/);
});

// invariant: the harness records the decisions it made. It never sees the operator's answer, and it cannot see
// whether a question it did not ask would have helped — so precision and recall over blockers are outside what it
// can compute. Naming the metric while measuring half of it is the class of claim this project keeps removing.
test("the report claims no metric it cannot compute", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.shell.byRule = { "shell-posture-paired": 2 };
  const markdown = sessionReportMarkdown(rollup);
  for (const claim of ["Ask-F1", "precision", "recall", "F1"]) {
    assert.equal(markdown.includes(claim), false, claim);
  }
});

// hazard: a rollup written by an older build has no `byRule`, and the report runs on whatever is on disk.
test("a rollup from an older build renders instead of throwing", () => {
  const rollup = newRollup("session-a", "provider-a");
  (rollup.shell as { byRule?: Record<string, number> }).byRule = undefined;
  assert.doesNotThrow(() => sessionReportMarkdown(rollup));
});

// why: the question that decides something. A rail that never fired is either working perfectly or was never
// needed, and either way it is paying for injected prose on every turn.
test("railsNeverFired names an enabled rail with no firings and omits one that fired", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.railsByRule = { "shell-posture-paired": 3 };
  assert.deepEqual(railsNeverFired(rollup, ["shell-posture-paired", "shell-catastrophic", "comments"]), [
    "comments",
    "shell-catastrophic",
  ]);
});

// invariant: the active list is a parameter. A report that guessed it would accuse a rail nobody switched on.
test("railsNeverFired reports nothing when no rail is declared active", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.railsByRule = { "shell-catastrophic": 1 };
  assert.deepEqual(railsNeverFired(rollup, []), []);
});

test("the report names the silent rails and the price of the prose", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.railsByRule = { "shell-posture-paired": 4 };
  rollup.injected_chars = 2480;
  rollup.hook_context_reliable = true;
  const markdown = sessionReportMarkdown(rollup, ["shell-posture-paired", "comments"]);
  assert.match(markdown, /shell-posture-paired \| 4/);
  assert.match(markdown, /comments \| 0 — enabled and never fired/);
  assert.match(markdown, /2480 characters/);
  assert.match(markdown, /paid on every turn/);
});

/**
 * hazard: the line read "that is the price of the rails above, paid on every turn" for every provider. On a host that
 * drops context returned from its session-start hook it is paid never, so the report was charging the operator for
 * prose the model never saw ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("a provider that drops hook context is not charged for the emission", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.injected_chars = 2480;
  rollup.hook_context_reliable = false;
  const markdown = sessionReportMarkdown(rollup, []);
  assert.match(markdown, /2480 characters/);
  assert.match(markdown, /does not deliver context/);
  assert.doesNotMatch(markdown, /paid on every turn/);
});

// invariant: the file the harness wrote is counted, because that is what the host is asked to read every request.
test("the durable view's size is reported next to the emission it replaces", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.injected_chars = 2480;
  rollup.durable_chars = 912;
  rollup.hook_context_reliable = false;
  const markdown = sessionReportMarkdown(rollup, []);
  assert.match(markdown, /912 characters, written as an always-applied rules file/);
  assert.match(markdown, /every request/);
});

// invariant: silent when there is nothing to charge for. A cost section on a session that injected nothing is noise.
test("a session that injected nothing says nothing about cost", () => {
  const markdown = sessionReportMarkdown(newRollup("session-a", "provider-a"), []);
  assert.doesNotMatch(markdown, /characters/);
});

test("a per-gate breakdown separates one flaky gate from a broken build", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.gates = { pass: 3, fail: 2 };
  rollup.gatesByName = { lint: { pass: 3, fail: 0 }, test: { pass: 0, fail: 2 } };
  const markdown = sessionReportMarkdown(rollup, []);
  assert.match(markdown, /↳ test \| 0 \/ 2/);
  assert.match(markdown, /↳ lint \| 3 \/ 0/);
});

// hazard: a rollup written by an older build has none of these fields, and the report runs on whatever is on disk.
test("a rollup from an older build renders instead of throwing", () => {
  const rollup = newRollup("session-a", "provider-a") as unknown as Record<string, unknown>;
  rollup.railsByRule = undefined;
  rollup.gatesByName = undefined;
  assert.doesNotThrow(() => sessionReportMarkdown(rollup as never, ["comments"]));
});

test("with no rail activity at all the report grows no rails section", () => {
  const markdown = sessionReportMarkdown(newRollup("session-a", "provider-a"), []);
  assert.doesNotMatch(markdown, /## Rails/);
});

// why: the question an operator asks when a turn takes thirty minutes. The runs column is what makes the
// multiplication visible — six runs of a four-minute suite is the answer, and no hook tuning would have changed it.
test("the report shows runs, total and worst per gate, worst-total first", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.gateTime = {
    lint: { runs: 3, totalMs: 9_000, worstMs: 3_500 },
    test: { runs: 3, totalMs: 720_000, worstMs: 250_000 },
  };
  const markdown = sessionReportMarkdown(rollup, []);
  assert.match(markdown, /## Gate time/);
  assert.match(markdown, /\| test \| 3 \| 0 \| 720\.0 \| 250\.0 \|/);
  assert.ok(markdown.indexOf("| test |") < markdown.indexOf("| lint |"), "worst total must come first");
  assert.match(markdown, /once per attempt/);
});

/**
 * why: the reused column is what makes the saving visible. Without it, a session where the suite ran once and was
 * reused five times reads identically to one where it ran once and nothing else happened
 * ([/decisions/ad-045.md](/decisions/ad-045.md)).
 */
test("the report counts reused verdicts apart from runs, and they add no time", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.gateTime = { test: { runs: 1, totalMs: 240_000, worstMs: 240_000, reused: 5 } };
  const markdown = sessionReportMarkdown(rollup, []);
  assert.match(markdown, /\| test \| 1 \| 5 \| 240\.0 \| 240\.0 \|/);
  assert.match(markdown, /the runs the harness did not make you pay for/);
});

// hazard: a rollup written before the field existed has no `reused`, and rendering `undefined` in a table cell is
// what turns a missing number into the word "undefined" in an operator's report.
test("a rollup written before the reused column renders zero, not undefined", () => {
  const rollup = newRollup("session-a", "provider-a");
  rollup.gateTime = { lint: { runs: 2, totalMs: 1_000, worstMs: 600 } };
  const markdown = sessionReportMarkdown(rollup, []);
  assert.match(markdown, /\| lint \| 2 \| 0 \| 1\.0 \| 0\.6 \|/);
  assert.doesNotMatch(markdown, /undefined/);
});

test("no gate time renders no section", () => {
  assert.doesNotMatch(sessionReportMarkdown(newRollup("session-a", "provider-a"), []), /## Gate time/);
});

// hazard: a rollup written before this change has no gateTime, and the report runs on whatever is on disk.
test("a rollup from an older build renders instead of throwing", () => {
  const rollup = newRollup("session-a", "provider-a") as unknown as Record<string, unknown>;
  rollup.gateTime = undefined;
  assert.doesNotThrow(() => sessionReportMarkdown(rollup as never, []));
});

/**
 * hazard: the reading attached to each event is the transcript tail's total, not a delta. Accumulating it across
 * 3,488 events reported 102.7M output tokens against 559k input ([/decisions/ad-064.md](/decisions/ad-064.md)).
 */
test("a token reading is assigned, never accumulated", async () => {
  const { recordObs, DEFAULT_OBS } = await import("../observability.service.ts");
  const { getRollup } = await import("../observability.store.ts");
  const root = mkdtempSync(join(tmpdir(), "obs-tokens-"));
  try {
    for (const output of [100, 250, 180]) {
      recordObs(
        root,
        { ...DEFAULT_OBS, debugEnabled: true },
        {
          provider: "p",
          kind: "tool.end",
          sessionKey: "s1",
          attrs: { tool_name: "Read" },
          gen_ai: { input_tokens: 10, output_tokens: output, cost_usd: 0.5 },
        },
      );
    }
    const rollup = getRollup(root, "s1");
    assert.equal(rollup?.output_tokens, 180, "the latest reading, not 530");
    assert.equal(rollup?.input_tokens, 10);
    assert.equal(rollup?.estimated_cost_usd, 0.5, "cost is the latest reading too, not 1.5");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// hazard: a successful shell call is `shell.end` and a failed one is `tool.fail`, so a shell tool in the tools
// table can only ever show failures. It read `Bash: 0 ok, 23 fail` after hundreds of successful calls.
test("a shell tool is not listed in the tools table it cannot be counted in", async () => {
  const { sessionReportScreen, SHELL_TOOLS } = await import("../observability.report.ts");
  assert.ok(SHELL_TOOLS.has("Bash"));
  const rollup = {
    ...newRollup("p", "s1"),
    tools: { Bash: { ok: 0, fail: 23, ms: 0 }, Read: { ok: 5, fail: 0, ms: 1 } },
  };
  const screen = sessionReportScreen(rollup as never);
  const labels = screen.sections.flatMap((section) => (section.rows ?? []).map((row) => row.label));
  assert.equal(labels.includes("Bash"), false, "the row could only ever report failures");
  assert.equal(labels.includes("Read"), true);
});
