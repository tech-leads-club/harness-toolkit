import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS } from "../../policy/policy.defaults.ts";
import { appendShipLedger, hasRecentEvidence, newestChangeMs, readShipLedger } from "../ship.ledger.ts";
import {
  detectShipClaim,
  evaluateEmptyDiffAntiShip,
  evaluateShipEvidenceGate,
  pathExcluded,
  recentShipClaimActive,
  touchesRuntime,
} from "../ship.service.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-ship-"));
}

test("detectShipClaim ignores free-English done/shipped language", () => {
  assert.equal(detectShipClaim("Task is done and complete, all fixed."), null);
  assert.equal(detectShipClaim("Ready to merge after review."), null);
  assert.equal(detectShipClaim("shipped to production yesterday."), null);
});

test("detectShipClaim only fires on the HARNESS_SHIP_CLAIM: marker", () => {
  const claim = detectShipClaim("Work finished.\nHARNESS_SHIP_CLAIM: release evidence PASS\nThanks.");
  assert.ok(claim);
  assert.equal(claim?.kind, "structured");
  assert.match(claim?.snippet ?? "", /^HARNESS_SHIP_CLAIM: release evidence/);
});

test("pathExcluded matches a directory-prefix exclude", () => {
  assert.equal(pathExcluded("vendor/cache/tmp.bin", ["vendor/"]), true);
});

test("pathExcluded matches a literal-directory exclude under .tlc/", () => {
  assert.equal(pathExcluded(".tlc/harness/config.json", [".tlc/"]), true);
});

test("pathExcluded is false when nothing matches", () => {
  assert.equal(pathExcluded("src/app.ts", [".tlc/", "vendor/"]), false);
});

test("touchesRuntime is false for an excluded path", () => {
  assert.equal(
    touchesRuntime(
      ["vendor/cache/tmp.bin"],
      DEFAULTS.shipGate.runtimePathPrefixes,
      DEFAULTS.shipGate.runtimePathExcludes,
    ),
    false,
  );
});

test("touchesRuntime is true for a src path", () => {
  assert.equal(
    touchesRuntime(
      ["src/app.ts"],
      DEFAULTS.shipGate.runtimePathPrefixes,
      DEFAULTS.shipGate.runtimePathExcludes,
    ),
    true,
  );
});

test("touchesRuntime is true for a scripts path", () => {
  assert.equal(
    touchesRuntime(
      ["scripts/release.ts"],
      DEFAULTS.shipGate.runtimePathPrefixes,
      DEFAULTS.shipGate.runtimePathExcludes,
    ),
    true,
  );
});

test("the default excludes name .tlc/, and touchesRuntime honors it as the harness's own state path", () => {
  assert.ok(DEFAULTS.shipGate.runtimePathExcludes.includes(".tlc/"));
  assert.equal(
    touchesRuntime(
      [".tlc/harness/state/gate-sessions/session.json"],
      DEFAULTS.shipGate.runtimePathPrefixes,
      DEFAULTS.shipGate.runtimePathExcludes,
    ),
    false,
  );
});

test("hasRecentEvidence is true for a fresh PASS verdict", () => {
  const dir = tempRoot();
  try {
    const evidence = join(dir, "evidence");
    const run = join(evidence, "run1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "90-verdict.txt"), "PASS\ndelivery=path-A\n");
    assert.equal(hasRecentEvidence(evidence, 48), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasRecentEvidence is false for a FAIL verdict", () => {
  const dir = tempRoot();
  try {
    const evidence = join(dir, "evidence");
    const run = join(evidence, "run1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "90-verdict.txt"), "FAIL\n");
    assert.equal(hasRecentEvidence(evidence, 48), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasRecentEvidence is false when the evidence directory does not exist", () => {
  const dir = tempRoot();
  try {
    assert.equal(hasRecentEvidence(join(dir, "no-such-dir"), 48), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recentShipClaimActive is true inside the claim window", () => {
  const now = Date.parse("2026-07-29T10:10:00.000Z");
  assert.equal(recentShipClaimActive("2026-07-29T10:05:00.000Z", 10, now), true);
});

test("recentShipClaimActive is false outside the claim window or with no timestamp", () => {
  const now = Date.parse("2026-07-29T10:20:00.000Z");
  assert.equal(recentShipClaimActive("2026-07-29T10:05:00.000Z", 10, now), false);
  assert.equal(recentShipClaimActive(undefined, 10, now), false);
});

test("appendShipLedger records the provider on every row", () => {
  const root = tempRoot();
  try {
    appendShipLedger(root, { provider: "provider-a", event: "claim", claimKind: "structured" });
    const rows = readShipLedger(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.provider, "provider-a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger rows record claim, challenge, and pass events distinctly", () => {
  const root = tempRoot();
  try {
    appendShipLedger(root, { provider: "provider-a", event: "claim", claimKind: "structured" });
    appendShipLedger(root, { provider: "provider-a", event: "challenge", gate: "ship" });
    appendShipLedger(root, { provider: "provider-b", event: "pass", gate: "ship" });
    const rows = readShipLedger(root);
    assert.deepEqual(
      rows.map((r) => r.event),
      ["claim", "challenge", "pass"],
    );
    assert.equal(rows[2]?.provider, "provider-b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateEmptyDiffAntiShip continues the turn when enabled, claimed, and the diff is empty", () => {
  const decision = evaluateEmptyDiffAntiShip({ enabled: true, recentShipClaim: true, changedFilesCount: 0 });
  assert.equal(decision.kind, "continue");
});

test("evaluateEmptyDiffAntiShip abstains when the diff is not empty", () => {
  const decision = evaluateEmptyDiffAntiShip({ enabled: true, recentShipClaim: true, changedFilesCount: 3 });
  assert.equal(decision.kind, "abstain");
});

test("evaluateEmptyDiffAntiShip abstains when the gate is disabled", () => {
  const decision = evaluateEmptyDiffAntiShip({ enabled: false, recentShipClaim: true, changedFilesCount: 0 });
  assert.equal(decision.kind, "abstain");
});

test("evaluateShipEvidenceGate continues the turn when runtime files changed without recent evidence", () => {
  const decision = evaluateShipEvidenceGate({
    enabled: true,
    recentShipClaim: true,
    changedFiles: ["src/app.ts"],
    runtimePathPrefixes: DEFAULTS.shipGate.runtimePathPrefixes,
    runtimePathExcludes: DEFAULTS.shipGate.runtimePathExcludes,
    evidenceDir: null,
    evidenceMaxAgeHours: 48,
  });
  assert.equal(decision.kind, "continue");
});

test("evaluateShipEvidenceGate abstains when recent evidence exists", () => {
  const dir = tempRoot();
  try {
    const evidence = join(dir, "evidence");
    mkdirSync(join(evidence, "run1"), { recursive: true });
    writeFileSync(join(evidence, "run1", "90-verdict.txt"), "PASS\n");
    const decision = evaluateShipEvidenceGate({
      enabled: true,
      recentShipClaim: true,
      changedFiles: ["src/app.ts"],
      runtimePathPrefixes: DEFAULTS.shipGate.runtimePathPrefixes,
      runtimePathExcludes: DEFAULTS.shipGate.runtimePathExcludes,
      evidenceDir: evidence,
      evidenceMaxAgeHours: 48,
    });
    assert.equal(decision.kind, "abstain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateShipEvidenceGate abstains when the changed files never touch runtime paths", () => {
  const decision = evaluateShipEvidenceGate({
    enabled: true,
    recentShipClaim: true,
    changedFiles: ["docs/readme.md"],
    runtimePathPrefixes: DEFAULTS.shipGate.runtimePathPrefixes,
    runtimePathExcludes: DEFAULTS.shipGate.runtimePathExcludes,
    evidenceDir: null,
    evidenceMaxAgeHours: 48,
  });
  assert.equal(decision.kind, "abstain");
});

// hazard: freshness is not what makes evidence evidence. A verdict written ten minutes ago used to pass while the
// code it certified changed five minutes ago — evidence that predates the change proves nothing about it, and the
// gate accepted it in silence.
function evidenceAt(dir: string, secondsAgo: number, body = "PASS\n"): string {
  const run = join(dir, "evidence", `run-${secondsAgo}`);
  mkdirSync(run, { recursive: true });
  const verdict = join(run, "90-verdict.txt");
  writeFileSync(verdict, body);
  const at = (Date.now() - secondsAgo * 1000) / 1000;
  utimesSync(verdict, at, at);
  return join(dir, "evidence");
}

function codeAt(dir: string, secondsAgo: number): number {
  const file = join(dir, "app.ts");
  writeFileSync(file, "export const a = 1;\n");
  const at = (Date.now() - secondsAgo * 1000) / 1000;
  utimesSync(file, at, at);
  return Date.now() - secondsAgo * 1000;
}

test("evidence older than the code it certifies does not count, however fresh it is", () => {
  const dir = tempRoot();
  try {
    const evidence = evidenceAt(dir, 600);
    const changedAt = codeAt(dir, 300);
    // why: 48h window, so age alone would accept it. Ordering is what refuses.
    assert.equal(hasRecentEvidence(evidence, 48), true, "age alone accepts it");
    assert.equal(hasRecentEvidence(evidence, 48, changedAt), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence newer than the code and inside the window counts", () => {
  const dir = tempRoot();
  try {
    const changedAt = codeAt(dir, 600);
    const evidence = evidenceAt(dir, 300);
    assert.equal(hasRecentEvidence(evidence, 48, changedAt), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// invariant: age keeps its job. It catches a verdict left from last week when nothing changed at all, which
// ordering cannot see.
test("with no code change the age window decides alone, exactly as before", () => {
  const dir = tempRoot();
  try {
    const evidence = evidenceAt(dir, 3 * 60 * 60);
    assert.equal(hasRecentEvidence(evidence, 48, undefined), true);
    assert.equal(hasRecentEvidence(evidence, 1, undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// why: a missing input must not fail closed on a gate that blocks a stop. Absent ordering means age decides.
test("newestChangeMs returns undefined when no path resolves, and the gate falls back to age", () => {
  const dir = tempRoot();
  try {
    assert.equal(newestChangeMs(dir, []), undefined);
    assert.equal(newestChangeMs(dir, ["does/not/exist.ts"]), undefined);
    const evidence = evidenceAt(dir, 60);
    assert.equal(hasRecentEvidence(evidence, 48, newestChangeMs(dir, ["does/not/exist.ts"])), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("newestChangeMs takes the newest of several paths", () => {
  const dir = tempRoot();
  try {
    codeAt(dir, 900);
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    const newer = (Date.now() - 60 * 1000) / 1000;
    utimesSync(join(dir, "b.ts"), newer, newer);
    const found = newestChangeMs(dir, ["app.ts", "b.ts"]);
    assert.ok(found !== undefined);
    assert.ok(Date.now() - (found as number) < 120_000, "expected the newer of the two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// invariant: the ship gate itself refuses, not just the helper. A helper that is right while the gate ignores it
// is the class of defect this project keeps finding.
test("the ship gate blocks when the only evidence predates the change", () => {
  const dir = tempRoot();
  try {
    const evidence = evidenceAt(dir, 600);
    const changedAt = codeAt(dir, 120);
    const decision = evaluateShipEvidenceGate({
      enabled: true,
      recentShipClaim: true,
      changedFiles: ["src/app.ts"],
      runtimePathPrefixes: ["src"],
      runtimePathExcludes: [],
      evidenceDir: evidence,
      evidenceMaxAgeHours: 48,
      evidenceNotBeforeMs: changedAt,
    });
    assert.equal(decision.kind, "continue");
    assert.match(decision.kind === "continue" ? decision.text : "", /before the change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
