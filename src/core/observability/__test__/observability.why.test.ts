import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionsFrom, NOTHING_WAS_THE_HARNESS, summarise, whyText } from "../observability.why.ts";

let clock = 0;
function event(kind: string, attrs: Record<string, unknown>, session = "s1") {
  clock += 1;
  return {
    schema: "harness.observability.v1",
    provider: "p",
    kind,
    level: "signal",
    ts: new Date(Date.UTC(2026, 0, 1, 12, 0, clock)).toISOString(),
    session_id: session,
    attrs,
  } as never;
}

test("a refusal is listed with the event it answered, the verdict and the rule", () => {
  const decisions = decisionsFrom([
    event("policy.deny", {
      event: "tool.before",
      permission: "deny",
      rule: "subagent-allowlist",
      tool_name: "Task",
    }),
  ]);
  assert.deepEqual(
    decisions.map((d) => [d.about, d.verdict, d.rule, d.detail]),
    [["tool.before", "deny", "subagent-allowlist", "Task"]],
  );
});

// why: the allow matters. "It let it through" is a decision, and its absence is what makes an operator wonder
// whether the harness was involved at all.
test("a shell allow is a decision, not an absence", () => {
  const decisions = decisionsFrom([
    event("shell.start", { permission: "allow", command: "ls -la", rule: "none" }),
  ]);
  assert.equal(decisions[0]?.verdict, "allow");
  assert.equal(decisions[0]?.rule, null);
});

test("a gate outcome and a session injection are decisions too", () => {
  const decisions = decisionsFrom([
    event("gate.outcome", { gate: "test", passed: false, scoped_env: "TLC_PROJECT_DIR" }),
    event("session.start", { injected_chars: 4210 }),
  ]);
  assert.deepEqual(decisions.map((d) => d.about).sort(), ["gate test", "session start"]);
  assert.match(decisions.find((d) => d.about === "gate test")?.detail ?? "", /env: TLC_PROJECT_DIR/);
});

// invariant: activity is not a decision. A turn doing work is not the harness doing something, and listing it
// would bury the lines that matter.
test("ordinary activity is not listed", () => {
  const decisions = decisionsFrom([
    event("tool.end", { tool_name: "Read" }),
    event("prompt.submit", {}),
    event("file.edit", { file_path: "a.ts" }),
  ]);
  assert.deepEqual(decisions, []);
});

test("another session's decisions never appear", () => {
  const decisions = decisionsFrom(
    [
      event("policy.deny", { permission: "deny", rule: "r" }, "mine"),
      event("policy.deny", { permission: "deny", rule: "r" }, "theirs"),
    ],
    "mine",
  );
  assert.equal(decisions.length, 1);
});

test("newest first, whichever plane it arrived from", () => {
  const first = event("shell.start", { permission: "deny", command: "a", rule: "r" });
  const second = event("shell.start", { permission: "deny", command: "b", rule: "r" });
  assert.deepEqual(
    decisionsFrom([first, second]).map((d) => d.detail),
    ["b", "a"],
  );
});

/**
 * why: the empty case is the feature. "Nothing here was the harness" is the sentence no other command gives, and
 * an empty table would leave the operator exactly as unsure as before ([/decisions/ad-062.md](/decisions/ad-062.md)).
 */
test("no decision in the window says so, in words", () => {
  for (const line of NOTHING_WAS_THE_HARNESS.split("\n")) {
    assert.ok(whyText([]).includes(line), line);
  }
  assert.match(whyText([]), /was the model, not a rail/);
});

test("a record written before rule was required reads as unattributed, never as blank", () => {
  const text = whyText(decisionsFrom([event("policy.deny", { permission: "deny", rule: "none" })]));
  assert.match(text, /rule=unattributed/);
  assert.doesNotMatch(text, / +$/m);
});

test("the plain rendering carries no escape, whatever it contains", () => {
  const text = whyText(
    decisionsFrom([event("policy.deny", { permission: "deny", rule: "r", tool_name: "Task" })]),
  );
  assert.equal(text.includes(String.fromCharCode(27)), false);
});

test("a summary line counts the verdicts, so ten lines have a headline", () => {
  const decisions = decisionsFrom([
    event("policy.deny", { permission: "deny", rule: "a" }),
    event("policy.deny", { permission: "deny", rule: "b" }),
    event("shell.start", { permission: "ask", rule: "c", command: "x" }),
    event("shell.start", { permission: "allow", command: "y" }),
  ]);
  assert.deepEqual(summarise(decisions), { denied: 2, asked: 1, allowed: 1, other: 0 });
  assert.match(whyText(decisions), /2 denied .* 1 asked .* 1 allowed/);
});

// hazard: the first version printed ten identical times with no date. It read as one burst and spanned three
// days, which is the opposite of what the reader needed to know.
test("a record from another day carries its date; today's does not", () => {
  const now = new Date("2026-01-01T12:00:30.000Z");
  const base = decisionsFrom([event("policy.deny", { permission: "deny", rule: "r" })])[0];
  assert.ok(base);
  assert.match(whyText([{ ...base, ts: "2025-12-28T09:15:00.000Z" }], undefined, now), /2025-12-28 09:15:00/);
  assert.doesNotMatch(whyText([{ ...base, ts: "2026-01-01T09:15:00.000Z" }], undefined, now), /2026-01-01 /);
});

/**
 * hazard: observation mode exists to produce a reading an operator acts on, and no command showed one — the rail
 * recorded into a plane nothing read. The orphan report in `check-obs-contract` found it on its first run
 * ([/decisions/ad-065.md](/decisions/ad-065.md)).
 */
test("an observation reading and a cost alert are decisions the harness made", () => {
  const decisions = decisionsFrom([
    event("policy.observe", { rail: "comments", reading: "held-without-prose", violations: 0 }),
    event("cost.session_alert", { estimated_cost_usd: 12.5 }),
  ]);
  assert.deepEqual(decisions.map((d) => [d.about, d.verdict]).sort(), [
    ["cost alert", "alert"],
    ["observe comments", "held-without-prose"],
  ]);
  assert.match(whyText(decisions), /passed the session threshold/);
});

// invariant: the declared set is what the contract checks against. A kind added to the switch and not here is a
// consumer the contract cannot see.
test("every kind the renderer branches on is declared", async () => {
  const { WHY_KINDS } = await import("../observability.why.ts");
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../observability.why.ts", import.meta.url), "utf8"),
  );
  const branched = [...source.matchAll(/event\.kind === "([a-z._]+)"/g)].map((m) => m[1] as string);
  assert.deepEqual([...new Set(branched)].sort(), [...WHY_KINDS].sort());
});
