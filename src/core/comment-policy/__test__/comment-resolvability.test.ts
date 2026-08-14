import assert from "node:assert/strict";
import { test } from "node:test";
import { findAddedComments } from "../comment-policy.service.ts";
import { findLeaks, firstLeak, LEAK_RULES, leakReason } from "../comment-resolvability.ts";

function added(lines: string[], file = "a.ts"): { file: string; line: number; text: string }[] {
  return lines.map((text, index) => ({ file, line: index + 1, text }));
}

test("every leak class fires on the comment a session actually produces", () => {
  const cases: [string, string][] = [
    ["// why: this used to read HEAD, so a committing turn missed everything", "change-narration"],
    ["// why: previously the counter read the signal plane", "change-narration"],
    ["// why: this was three regexes before", "change-narration"],
    ["// why: the old implementation summed the snapshots", "change-narration"],
    ["// why: before this change the lock was never released", "change-narration"],
    ["// why: bounded to four, per (decision 3)", "dead-citation"],
    ["// why: see §4.7 for the rationale", "dead-citation"],
    ["// why: as agreed above, the base is the turn sha", "dead-citation"],
    ["// why: per the plan, this runs after the gate", "dead-citation"],
    ["// why: this PR moves the resolver into core", "review-vantage"],
    ["// why: a later PR will collapse the two adapters", "review-vantage"],
    ["// why: this is safe because the value is frozen", "reviewer-addressed"],
    ["// why: the reviewer asked for the extra guard", "reviewer-addressed"],
    ["// why: first we resolve the home, then we read the config", "flow-narration"],
  ];
  for (const [text, kind] of cases) {
    const leak = firstLeak(text);
    assert.notEqual(leak, null, text);
    assert.equal(leak?.kind, kind, text);
  }
});

/**
 * hazard: these are the passages the first pattern set flagged and should not have. Every `no longer` in this
 * repository described runtime state — a lock owner, a lesson ref, a path a future refactor would leave — and
 * none described the repository's own history. A rail that flags four good comments to catch zero bad ones is a
 * rail the operator switches off.
 */
test("a comment about runtime state, a hypothetical, or a measured bound is not a leak", () => {
  const keep = [
    "// why: an owner that no longer exists has nothing to wait for",
    "/** Project lessons whose refs no longer resolve. Reported, never auto-deleted. */",
    "// why: one refactor away from naming an event that no longer exists",
    "// why: the old connection drains before the new one accepts",
    "// hazard: without the guard, `**Provider:**` reads as a block continuation",
    "// why: measured at 512 nests in 0.15s, so the bound is not arbitrary",
    "// why: a naive reader would take the tail as a delta",
    "// TODO(felipe): fold this into the loader once #1470 lands",
    "// why: the turn base is the sha the turn started from",
  ];
  for (const text of keep) {
    assert.equal(firstLeak(text), null, text);
  }
});

test("a block is judged as one string, so a split sentence still matches", () => {
  const split = "// why: first we resolve the home,\n// then we read the config from it";
  assert.equal(firstLeak(split.split("\n").join(" "))?.kind, "flow-narration");
  // invariant: the same sentence on one line only is not enough to fire the two-clause rule.
  assert.equal(firstLeak("// why: first we resolve the home"), null);
});

test("one comment yields one finding even when it trips several rules", () => {
  const busy = "// why: this used to be wrong, see (decision 2), and this PR fixes it";
  assert.equal(findLeaks(busy).length > 1, true, "several rules match");
  assert.notEqual(firstLeak(busy), null);
});

test("the message names the phrase, so the fix does not need a second reading", () => {
  const leak = firstLeak("// why: this used to read HEAD");
  assert.notEqual(leak, null);
  const reason = leakReason(leak as NonNullable<typeof leak>);
  assert.equal(reason.includes("used to"), true);
  assert.equal(reason.startsWith("unresolvable comment"), true);
});

test("resolvable mode is declared mode plus the question declared cannot ask", () => {
  const leaky = added(["// why: this used to read HEAD, which a committing turn moves"]);
  assert.deepEqual(findAddedComments(leaky, "declared"), [], "declared accepts it — it has a reason");
  const strictly = findAddedComments(leaky, "resolvable");
  assert.equal(strictly.length, 1);
  assert.equal(strictly[0]?.reason.includes("unresolvable"), true);
});

test("resolvable mode still refuses what declared refuses, and reports it once", () => {
  const undeclared = added(["// this used to read HEAD"]);
  const findings = findAddedComments(undeclared, "resolvable");
  assert.equal(findings.length, 1);
  // invariant: the undeclared refusal wins. Reporting both would turn one comment into two problems to fix.
  assert.equal(findings[0]?.reason, "undeclared comment added this turn");
});

test("a resolvable comment passes resolvable mode", () => {
  const clean = added(["// why: the turn base is the sha the turn started from, not HEAD"]);
  assert.deepEqual(findAddedComments(clean, "resolvable"), []);
});

test("strict mode is unchanged by the new mode existing", () => {
  const clean = added(["// why: the turn base is the sha the turn started from"]);
  assert.equal(findAddedComments(clean, "strict").length, 1);
  assert.equal(findAddedComments(clean, "strict")[0]?.reason, "comment added this turn");
});

// why: the rule set is data, and a rule with no class or no explanation produces a finding an operator cannot act
// on. Checking the shape here is cheaper than discovering it from a blocked turn.
test("every rule declares a class and says what the reader cannot do", () => {
  for (const rule of LEAK_RULES) {
    assert.equal(typeof rule.kind, "string");
    assert.equal(rule.says.length > 10, true, rule.kind);
    assert.equal(rule.pattern instanceof RegExp, true);
    assert.equal(rule.pattern.global, false, "a global regex carries lastIndex between calls");
  }
});

/**
 * hazard: a mutant that judged only the block's first line survived every test here, because the split-sentence
 * test exercised the pure function and never the rail. A leak on the second line of a declared block is the
 * shape that escaped.
 */
test("the rail judges the whole block, not its first line", () => {
  const block = added([
    "// why: the base is the sha the turn started from,",
    "//      which this used to get wrong by reading HEAD",
  ]);
  const findings = findAddedComments(block, "resolvable");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.reason.includes("used to"), true, findings[0]?.reason);
});

test("a doc comment's body is judged too, not only its opening line", () => {
  const doc = added([
    "/**",
    " * Resolves the runtime home from the environment.",
    " * why: this used to read the checkout path, which a move invalidated.",
    " */",
    "export function runtimeHome() {}",
  ]);
  const nextCode = (_file: string, line: number) => (line === 5 ? "export function runtimeHome() {}" : "");
  const findings = findAddedComments(doc.slice(0, 4), "resolvable", nextCode);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.reason.includes("unresolvable"), true, findings[0]?.reason);
});
