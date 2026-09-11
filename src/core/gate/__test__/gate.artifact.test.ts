import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { handoffSessionPath } from "../../handoff/handoff.session-store.ts";
import {
  clearGateReport,
  computeGateFingerprint,
  extractFindingsFromOutput,
  gateReportPath,
  lastGatePath,
  pruneGateSessions,
  readLastGate,
  readReportFindings,
  trimOutputTail,
  writeLastGate,
} from "../gate.artifact.ts";
import { computeInputsHash } from "../gate.inputs.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-gate-artifact-"));
}

test("extractFindingsFromOutput prefers FAIL/Error lines over passing noise", () => {
  const passNoise = Array.from({ length: 50 }, (_, i) => `✓ pass line ${i}`).join("\n");
  const failing = `${passNoise}\nFAIL src/x.spec.ts > does the thing\nError: expected 1 to be 2\n`;
  const findings = extractFindingsFromOutput(failing, 1);
  assert.ok(findings.some((f) => /FAIL|Error:/.test(f.summary)));
  assert.equal(
    findings.some((f) => f.summary.startsWith("✓ pass")),
    false,
  );
});

test("extractFindingsFromOutput on empty output reports the exit code", () => {
  const empty = extractFindingsFromOutput("", 7);
  assert.equal(empty[0]?.summary, "gate exited with code 7");
});

test("writeLastGate with a placeholder output falls back to the exit-code summary", () => {
  const root = tempRoot();
  try {
    const artifact = writeLastGate({
      root,
      sessionKey: "session-1",
      gate: "test",
      exitCode: 3,
      command: ["false"],
      files: [],
      durationMs: 1,
      output: "(no output captured)",
    });
    assert.equal(artifact.findings[0]?.summary, "gate exited with code 3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trimOutputTail keeps the tail within the max and preserves the trailing marker", () => {
  const long = `${"a".repeat(9000)}TAIL_MARK`;
  const trimmed = trimOutputTail(long);
  assert.ok(trimmed.endsWith("TAIL_MARK"));
  assert.ok(trimmed.length <= 8000);
});

test("readReportFindings prefers the report file's own findings", () => {
  const root = tempRoot();
  try {
    const report = gateReportPath(root);
    mkdirSync(join(root, ".tlc", "harness", "state"), { recursive: true });
    writeFileSync(
      report,
      JSON.stringify({
        findings: [{ id: "t1", summary: "reported failure A" }, { summary: "reported failure B" }],
      }),
    );
    const findings = readReportFindings(report);
    assert.equal(findings?.[0]?.summary, "reported failure A");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeLastGate uses report findings over output-extracted ones", () => {
  const root = tempRoot();
  try {
    const report = gateReportPath(root);
    mkdirSync(join(root, ".tlc", "harness", "state"), { recursive: true });
    writeFileSync(report, JSON.stringify({ findings: [{ summary: "reported failure A" }] }));

    const artifact = writeLastGate({
      root,
      sessionKey: "session-2",
      gate: "test",
      exitCode: 1,
      command: ["false"],
      files: ["src/a.ts"],
      durationMs: 12,
      output: "FAIL src/x.spec.ts\nError: nope\n",
      reportPath: report,
    });
    assert.equal(artifact.schema, "harness.gate.v1");
    assert.equal(artifact.passed, false);
    assert.equal(artifact.findings[0]?.summary, "reported failure A");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readLastGate round-trips what writeLastGate wrote", () => {
  const root = tempRoot();
  try {
    writeLastGate({
      root,
      sessionKey: "session-3",
      gate: "lint",
      exitCode: 0,
      command: ["biome", "check"],
      files: [],
      durationMs: 5,
      output: "",
    });
    const reloaded = readLastGate(root, "session-3");
    assert.equal(reloaded?.gate, "lint");
    assert.equal(reloaded?.passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computeGateFingerprint is order-independent across findings", () => {
  const root = tempRoot();
  try {
    const artifact = writeLastGate({
      root,
      sessionKey: "session-4",
      gate: "test",
      exitCode: 1,
      command: ["false"],
      files: ["src/a.ts"],
      durationMs: 1,
      output: "FAIL a\nFAIL b\n",
    });
    const fp1 = computeGateFingerprint(artifact);
    const fp2 = computeGateFingerprint({ ...artifact, findings: [...artifact.findings].reverse() });
    assert.equal(fp1, fp2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computeGateFingerprint differs when the findings differ", () => {
  const root = tempRoot();
  try {
    const artifact = writeLastGate({
      root,
      sessionKey: "session-5",
      gate: "test",
      exitCode: 1,
      command: ["false"],
      files: [],
      durationMs: 1,
      output: "FAIL a\n",
    });
    const fp1 = computeGateFingerprint(artifact);
    const fp2 = computeGateFingerprint({ ...artifact, findings: [{ summary: "other" }] });
    assert.notEqual(fp1, fp2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearGateReport removes an existing report and is a no-op when absent", () => {
  const root = tempRoot();
  try {
    const report = gateReportPath(root);
    mkdirSync(join(root, ".tlc", "harness", "state"), { recursive: true });
    writeFileSync(report, "{}");
    clearGateReport(root);
    assert.equal(existsSync(report), false);
    assert.doesNotThrow(() => clearGateReport(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * why: recorded on every gate, as a fact rather than an alarm, so a later reader can answer "what environment did
 * this run under" without the follow-up having had to say it ([/decisions/ad-060.md](/decisions/ad-060.md)).
 */
test("the artifact records which project-scoping variables were set", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-env-"));
  const original = process.env.TLC_PROJECT_DIR;
  try {
    process.env.TLC_PROJECT_DIR = "/somewhere";
    const set = writeLastGate({
      root,
      sessionKey: "session-6",
      gate: "test",
      exitCode: 1,
      command: ["node", "--test"],
      files: ["a.ts"],
      durationMs: 1,
      output: "boom",
    });
    assert.deepEqual(set.scopedEnv, ["TLC_PROJECT_DIR"]);

    delete process.env.TLC_PROJECT_DIR;
    const none = writeLastGate({
      root,
      sessionKey: "session-7",
      gate: "test",
      exitCode: 0,
      command: ["node", "--test"],
      files: [],
      durationMs: 1,
      output: "",
    });
    // invariant: an empty list, not an absent field — "none were set" is a reading, and absent means "unknown".
    assert.deepEqual(none.scopedEnv, []);
  } finally {
    if (original === undefined) {
      delete process.env.TLC_PROJECT_DIR;
    } else {
      process.env.TLC_PROJECT_DIR = original;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * AD-137 — the production incident: `last-gate.json` was a single project-wide file, read and written by
 * every concurrent session in the same checkout. One session's gate result surfaced as if it were another's.
 * Confirmed via `handoff.json` first, for a sibling mechanism ([/decisions/ad-122.md](/decisions/ad-122.md));
 * this closes the same defect class here.
 */
describe("gate artifacts are session-scoped", () => {
  test("PMS-01 a different session's artifact is invisible, even for the identical gate name", () => {
    const root = tempRoot();
    try {
      writeLastGate({
        root,
        sessionKey: "agent-fixing-code",
        gate: "lint",
        exitCode: 1,
        command: ["lint"],
        files: ["src/broken.ts"],
        durationMs: 10,
        output: "FAIL src/broken.ts",
      });

      const readByOtherSession = readLastGate(root, "agent-researching");

      assert.equal(
        readByOtherSession,
        null,
        "a different sessionKey must never see the writing session's own artifact",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PMS-02 the same session reads back exactly what it wrote — unchanged from before this record", () => {
    const root = tempRoot();
    try {
      writeLastGate({
        root,
        sessionKey: "same-session",
        gate: "lint",
        exitCode: 1,
        command: ["lint"],
        files: ["src/broken.ts"],
        durationMs: 10,
        output: "FAIL src/broken.ts",
      });

      const reloaded = readLastGate(root, "same-session");

      assert.equal(reloaded?.gate, "lint");
      assert.equal(reloaded?.passed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * PMS-03 — the exact incident reproduced at the artifact layer: two sessions whose command AND file
   * contents hash identically (the precise condition that let a cross-session cache hit happen before this
   * fix) must still never see each other's cached verdict.
   */
  test("PMS-03 two sessions with an identical inputsHash never share a cache hit", () => {
    const root = tempRoot();
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "shared.ts"), "export const x = 1;\n");
      const command = ["lint"];
      const inputs = computeInputsHash(root, ["shared.ts"], command);
      assert.equal(inputs.complete, true, "the fixture file must hash cleanly, or this test proves nothing");

      writeLastGate({
        root,
        sessionKey: "session-alpha",
        gate: "lint",
        exitCode: 1,
        command,
        files: ["shared.ts"],
        durationMs: 5,
        output: "FAIL shared.ts",
        inputsHash: inputs.hash,
      });

      const forSessionBeta = readLastGate(root, "session-beta");
      assert.equal(
        forSessionBeta,
        null,
        "session beta must not inherit alpha's cached, hash-matching verdict",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PMS-04 the path matches handoffSessionPath's own sanitizing convention for the same raw key", () => {
    const root = tempRoot();
    try {
      const raw = "session-conv/with:odd chars";
      const gatePath = lastGatePath(root, raw);
      const handoffPath = handoffSessionPath(root, raw);
      assert.equal(
        gatePath.split("/").pop(),
        handoffPath.split("/").pop(),
        "both mechanisms must sanitize the same raw sessionKey identically",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pruneGateSessions", () => {
  function writeArtifactAt(path: string, ts: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema: "harness.gate.v1",
        gate: "lint",
        exitCode: 0,
        passed: true,
        command: ["lint"],
        files: [],
        durationMs: 1,
        ts,
        outputTail: "",
        findings: [],
      }),
    );
  }

  test("PMS-05 a gate-session file older than maxAgeMs is pruned", () => {
    const root = tempRoot();
    try {
      const path = lastGatePath(root, "old-session");
      writeArtifactAt(path, "2020-01-01T00:00:00.000Z");

      const pruned = pruneGateSessions(root, { now: Date.parse("2026-01-01T00:00:00.000Z"), maxAgeMs: 1000 });

      assert.equal(pruned, 1);
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PMS-06 a gate-session file within the retention window is kept, regardless of liveness", () => {
    const root = tempRoot();
    try {
      const now = Date.now();
      const path = lastGatePath(root, "fresh-session");
      writeArtifactAt(path, new Date(now).toISOString());

      const pruned = pruneGateSessions(root, { now, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });

      assert.equal(pruned, 0);
      assert.equal(existsSync(path), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PMS-07 an empty or absent gate-sessions directory prunes nothing and does not throw", () => {
    const root = tempRoot();
    try {
      assert.doesNotThrow(() => {
        const pruned = pruneGateSessions(root);
        assert.equal(pruned, 0);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PMS-08 a file with an unparseable ts is kept, not deleted — doubt is not evidence of age", () => {
    const root = tempRoot();
    try {
      const path = lastGatePath(root, "torn-write-session");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"schema":"harness.gate.v1","gate":"lint","ts":"not-a-date"');

      const pruned = pruneGateSessions(root, { now: Date.now(), maxAgeMs: 1000 });

      assert.equal(pruned, 0);
      assert.equal(existsSync(path), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
