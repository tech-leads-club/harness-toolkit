import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CONSUMERS, check, planeOf, report } from "../dev/check-obs-contract.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the repository's own consumers satisfy the contract", () => {
  const outcome = check(repoRoot, CONSUMERS, []);
  assert.deepEqual(outcome.violations, []);
});

/**
 * hazard: the idle-turn counter read the signal plane while every kind it counted resolves to debug, so it read
 * zero for every turn whose work went well and the rail blocked the same turn four times in a row
 * ([/decisions/ad-059.md](/decisions/ad-059.md)). This is that defect, as an input.
 */
test("a consumer reading a plane its kinds never land on fails, naming the plane", () => {
  const outcome = check(repoRoot, [{ name: "idle", kinds: ["tool.end"], planes: ["obs.jsonl"] }], []);
  assert.equal(outcome.violations.length, 1);
  assert.equal(outcome.violations[0]?.rule, "plane-mismatch");
  assert.match(outcome.violations[0]?.detail ?? "", /lands on debug\.jsonl, but reads only obs\.jsonl/);
});

// hazard: `gate.outcome` was consumed by the session report and emitted by nothing, so "Gates pass/fail" read
// 0 / 0 for every gate this harness had ever run ([/decisions/ad-027.md](/decisions/ad-027.md)).
test("a kind nobody emits fails, naming the consumer", () => {
  const outcome = check(repoRoot, [{ name: "report", kinds: ["never.emitted"], planes: ["obs.jsonl"] }], []);
  assert.equal(outcome.violations.length, 1);
  assert.equal(outcome.violations[0]?.rule, "consumed-never-emitted");
  assert.match(outcome.violations[0]?.detail ?? "", /which no producer emits/);
});

// why: reported, never failed. A kind nothing reads costs a write per event and may be a rail half-built, which
// is a judgement for the operator rather than a build failure.
test("a kind emitted and read by nobody is listed, and the check still passes", () => {
  const outcome = check(repoRoot, [], ["gate.outcome"]);
  assert.deepEqual(outcome.violations, []);
  assert.deepEqual(outcome.orphans, ["gate.outcome"]);
  const printed = report(outcome);
  assert.equal(printed.ok, true);
  assert.match(printed.text, /read by no declared consumer: gate\.outcome/);
});

// invariant: the plane comes from resolveObsLevel, so a change to the plane rules cannot leave this stale.
test("the plane is the one the resolver actually assigns", () => {
  assert.equal(planeOf("gate.outcome"), "obs.jsonl");
  assert.equal(planeOf("tool.end"), "debug.jsonl");
  assert.equal(planeOf("session.start"), "obs.jsonl");
});
