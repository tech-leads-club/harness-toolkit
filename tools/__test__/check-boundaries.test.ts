import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, runBoundaryChecks, type Violation } from "../dev/check-boundaries.ts";

const CHECKER_PATH = fileURLToPath(new URL("../dev/check-boundaries.ts", import.meta.url));

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "check-boundaries-"));
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function checks(root: string) {
  return runBoundaryChecks({ root, ...DEFAULT_CONFIG });
}

function expectOneViolation(violations: Violation[]): Violation {
  assert.equal(violations.length, 1);
  const [violation] = violations;
  assert.ok(violation !== undefined, "expected a violation at index 0");
  return violation;
}

describe("runBoundaryChecks — clean fixture tree", () => {
  test("passes with zero violations on a clean fixture tree", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/core/gate/gate.service.ts",
      "export function decide(): string {\n  return 'allow';\n}\n",
    );
    write(
      root,
      "src/providers/cursor/cursor.detect.ts",
      "export function detect(raw: unknown): boolean {\n  return typeof raw === 'object';\n}\n",
    );
    assert.deepEqual(checks(root), []);
    rmSync(root, { recursive: true, force: true });
  });

  test("tolerates a missing scan directory without throwing", () => {
    const root = fixtureRoot();
    assert.doesNotThrow(() => checks(root));
    assert.deepEqual(checks(root), []);
    rmSync(root, { recursive: true, force: true });
  });

  test("does not flag a vendor identifier appearing outside src/core/", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/providers/cursor/cursor.wiring.ts",
      "// wires the cursor provider\nexport const NAME = 'cursor';\n",
    );
    const violations = checks(root).filter((v) => v.rule === "vendor-identifier-in-core");
    assert.deepEqual(violations, []);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("runBoundaryChecks — seeded violations", () => {
  test("fails when a vendor identifier appears in src/core/", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/core/gate/gate.service.ts",
      "export function decide(): string {\n  // claude needs special handling\n  return 'allow';\n}\n",
    );
    const violations = checks(root).filter((v) => v.rule === "vendor-identifier-in-core");
    const violation = expectOneViolation(violations);
    assert.equal(violation.file, join("src", "core", "gate", "gate.service.ts"));
    assert.equal(violation.line, 2);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when process.env.HOME appears in a scanned tree", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/platform/paths.ts",
      "export function bad(): string {\n  return process.env.HOME ?? '';\n}\n",
    );
    const violations = checks(root).filter((v) => v.rule === "process-env-home");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 2);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when .cursor/harness or .cursor/agent-harness appears in a scanned tree", () => {
    const root = fixtureRoot();
    write(root, "src/platform/legacy.ts", "export const OLD = '.cursor/agent-harness';\n");
    const violations = checks(root).filter((v) => v.rule === "cursor-legacy-path");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when process.env.HOME appears in tools/, now that the legacy tree is gone and the scan is widened", () => {
    const root = fixtureRoot();
    write(root, "tools/some-tool.ts", "export const home = process.env.HOME ?? '';\n");
    const violations = checks(root).filter((v) => v.rule === "process-env-home");
    const violation = expectOneViolation(violations);
    assert.equal(violation.file, join("tools", "some-tool.ts"));
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when .cursor/agent-harness appears in bin/, now that the scan is widened", () => {
    const root = fixtureRoot();
    write(root, "bin/some-bin.ts", "export const OLD = '.cursor/agent-harness';\n");
    const violations = checks(root).filter((v) => v.rule === "cursor-legacy-path");
    const violation = expectOneViolation(violations);
    assert.equal(violation.file, join("bin", "some-bin.ts"));
    rmSync(root, { recursive: true, force: true });
  });

  test("a vendor identifier in tools/ or bin/ is not flagged — vendor-identifier-in-core stays scoped to src/core and src/contracts", () => {
    const root = fixtureRoot();
    write(root, "tools/some-tool.ts", "// claude-specific helper\n");
    write(root, "bin/some-bin.ts", "// cursor-specific helper\n");
    const violations = checks(root).filter((v) => v.rule === "vendor-identifier-in-core");
    assert.deepEqual(violations, []);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when src/core/ imports from src/providers/", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/core/gate/gate.service.ts",
      'import { detect } from "../../providers/cursor/cursor.detect.ts";\n',
    );
    const violations = checks(root).filter((v) => v.rule === "core-imports-providers");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when src/providers/ imports from src/core/", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/providers/cursor/cursor.outbound.ts",
      'import { decide } from "../../core/gate/gate.service.ts";\n',
    );
    const violations = checks(root).filter((v) => v.rule === "providers-imports-core");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when src/contracts/ imports from src/core/", () => {
    const root = fixtureRoot();
    write(root, "src/contracts/decision.ts", 'import { decide } from "../core/gate/gate.service.ts";\n');
    const violations = checks(root).filter((v) => v.rule === "contracts-imports-core");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when src/contracts/ imports from src/providers/", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/contracts/decision.ts",
      'import { detect } from "../providers/cursor/cursor.detect.ts";\n',
    );
    const violations = checks(root).filter((v) => v.rule === "contracts-imports-providers");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when src/contracts/ imports from src/platform/", () => {
    const root = fixtureRoot();
    write(root, "src/contracts/decision.ts", 'import { git } from "../platform/git.ts";\n');
    const violations = checks(root).filter((v) => v.rule === "contracts-imports-platform");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when src/contracts/ imports from src/entrypoints/", () => {
    const root = fixtureRoot();
    write(root, "src/contracts/decision.ts", 'import { main } from "../entrypoints/stop.ts";\n');
    const violations = checks(root).filter((v) => v.rule === "contracts-imports-entrypoints");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test("does not flag src/contracts/ importing from another file within src/contracts/", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/contracts/harness-event.ts",
      'import type { EffortLevel } from "./effort.ts";\nexport type X = EffortLevel;\n',
    );
    const violations = checks(root).filter((v) => v.rule.startsWith("contracts-imports-"));
    assert.deepEqual(violations, []);
    rmSync(root, { recursive: true, force: true });
  });

  test("fails when a vendor identifier appears in src/contracts/", () => {
    const root = fixtureRoot();
    write(root, "src/contracts/decision.ts", "// cursor writes {} on abstain\n");
    const violations = checks(root).filter((v) => v.rule === "vendor-identifier-in-core");
    const violation = expectOneViolation(violations);
    assert.equal(violation.file, join("src", "contracts", "decision.ts"));
    rmSync(root, { recursive: true, force: true });
  });

  test("flags a vendor identifier inside a src/contracts/ __test__ file", () => {
    const root = fixtureRoot();
    write(root, "src/contracts/__test__/decision.test.ts", "const p = { provider: 'claude' };\n");
    const violations = checks(root).filter((v) => v.rule === "vendor-identifier-in-core");
    assert.equal(violations.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test("flags a vendor identifier inside a src/core/ __test__ file", () => {
    const root = fixtureRoot();
    write(root, "src/core/handoff/__test__/handoff.service.test.ts", "const slice = { cursor: {} };\n");
    const violations = checks(root).filter((v) => v.rule === "vendor-identifier-in-core");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test("does not flag process.env.HOME inside a __test__ file asserting its absence", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/platform/__test__/paths.test.ts",
      "assert.doesNotMatch(source, /process\\.env\\.HOME/);\n",
    );
    const violations = checks(root).filter((v) => v.rule === "process-env-home");
    assert.deepEqual(violations, []);
    rmSync(root, { recursive: true, force: true });
  });

  test("does not flag a .cursor path inside a __test__ file asserting its absence", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/platform/__test__/paths.test.ts",
      "assert.doesNotMatch(source, /\\.cursor\\/agent-harness/);\n",
    );
    const violations = checks(root).filter((v) => v.rule === "cursor-legacy-path");
    assert.deepEqual(violations, []);
    rmSync(root, { recursive: true, force: true });
  });

  test("violation carries the correct file and 1-based line number", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/core/gate/gate.service.ts",
      "export function decide(): string {\n\n  // anthropic model\n  return 'allow';\n}\n",
    );
    const violations = checks(root).filter((v) => v.rule === "vendor-identifier-in-core");
    const violation = expectOneViolation(violations);
    assert.equal(violation.line, 3);
    assert.equal(violation.file, join("src", "core", "gate", "gate.service.ts"));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("CLI executable", () => {
  test("exits 0 on a clean fixture tree", () => {
    const root = fixtureRoot();
    write(root, "src/platform/paths.ts", "export const ok = true;\n");
    const result = execFileSync("node", ["--experimental-strip-types", CHECKER_PATH], {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(result, /ok \(0 violations\)/);
    rmSync(root, { recursive: true, force: true });
  });

  test("exits non-zero on a seeded-violation fixture tree", () => {
    const root = fixtureRoot();
    write(root, "src/core/gate/gate.service.ts", "// claude special case\n");
    assert.throws(
      () => {
        execFileSync("node", ["--experimental-strip-types", CHECKER_PATH], {
          cwd: root,
          encoding: "utf8",
        });
      },
      (error: { status?: number }) => error.status !== 0,
    );
    rmSync(root, { recursive: true, force: true });
  });

  test("prints the offending file and line for each violation", () => {
    const root = fixtureRoot();
    write(root, "src/core/gate/gate.service.ts", "// claude special case\n");
    let stderr = "";
    try {
      execFileSync("node", ["--experimental-strip-types", CHECKER_PATH], { cwd: root, encoding: "utf8" });
    } catch (error) {
      stderr = (error as { stderr: string }).stderr;
    }
    assert.match(stderr, /gate\.service\.ts:1/);
    rmSync(root, { recursive: true, force: true });
  });
});
