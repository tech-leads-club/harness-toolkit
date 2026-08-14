import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { projectStateDir } from "../../src/platform/paths.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cleanup: string[] = [];

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(repoRoot, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// hazard: a caller that branches on the exit code and parses stdout must be able to do both. A failing
// command that prints prose under --json would break the parse exactly when the caller needs the detail.
describe("doctor --json on a failing install", () => {
  test("still emits one parseable value and keeps the non-zero exit", () => {
    const home = newDir("tlc-json-home-");
    const project = newDir("tlc-json-project-");
    const result = run("tools/doctor.ts", ["--json"], {
      TLC_HOME: join(home, "absent-runtime"),
      TLC_PROJECT_DIR: project,
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout) as { ok: boolean; failed: number; checks: unknown[] };
    assert.equal(report.ok, false);
    assert.ok(report.failed > 0);
    assert.ok(Array.isArray(report.checks));
  });

  test("the same failing install prints prose and exits 1 without the flag", () => {
    const home = newDir("tlc-json-home-");
    const project = newDir("tlc-json-project-");
    const result = run("tools/doctor.ts", [], {
      TLC_HOME: join(home, "absent-runtime"),
      TLC_PROJECT_DIR: project,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL/);
    assert.throws(() => JSON.parse(result.stdout));
  });
});

describe("unknown flags", () => {
  test("status refuses a flag it does not know instead of ignoring it", () => {
    const project = newDir("tlc-json-project-");
    const result = run("bin/tlc-cli.ts", ["harness", "status", "--wat"], { TLC_PROJECT_DIR: project });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown flag: --wat/);
  });

  test("status with only --json succeeds and emits a parseable value", () => {
    const project = newDir("tlc-json-project-");
    const result = run("bin/tlc-cli.ts", ["harness", "status", "--json"], { TLC_PROJECT_DIR: project });
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout) as { root: string };
    assert.equal(report.root, project);
  });
});

describe("obs prune", () => {
  test("drops expired spool records and reports the count", () => {
    const home = newDir("tlc-json-home-");
    const project = newDir("tlc-json-project-");
    mkdirSync(projectStateDir(project), { recursive: true });
    const spool = join(home, "state", "obs-spool.jsonl");
    mkdirSync(dirname(spool), { recursive: true });
    writeFileSync(
      spool,
      `${JSON.stringify({
        repo: project,
        project: "p",
        stream: "obs",
        record: { ts: "2020-01-01T00:00:00.000Z" },
      })}\n`,
    );
    const result = run("tools/obs-cli.ts", ["prune", "--json"], {
      TLC_HOME: home,
      TLC_PROJECT_DIR: project,
    });
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout) as { spoolDropped: number };
    assert.equal(report.spoolDropped, 1);
  });
});

describe("obs prune honours project retention", () => {
  function seedSpool(home: string, project: string, ageDays: number): void {
    const spool = join(home, "state", "obs-spool.jsonl");
    mkdirSync(dirname(spool), { recursive: true });
    const ts = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      spool,
      `${JSON.stringify({ repo: project, project: "p", stream: "obs", record: { ts } })}\n`,
    );
  }

  function writeObsPolicy(project: string, obs: Record<string, unknown>): void {
    mkdirSync(join(project, ".tlc", "harness"), { recursive: true });
    writeFileSync(join(project, ".tlc", "harness", "config.json"), JSON.stringify({ version: 1, obs }));
  }

  // hazard: retention was read from the module default, so a project asking for a shorter window was
  // ignored. A mutation restoring that default survived every other test in this suite.
  test("a two-day-old record survives the default window", () => {
    const home = newDir("tlc-retain-home-");
    const project = newDir("tlc-retain-project-");
    mkdirSync(projectStateDir(project), { recursive: true });
    seedSpool(home, project, 2);
    const result = run("tools/obs-cli.ts", ["prune", "--json"], { TLC_HOME: home, TLC_PROJECT_DIR: project });
    const report = JSON.parse(result.stdout) as { retentionDays: number; spoolDropped: number };
    assert.equal(report.retentionDays, 14);
    assert.equal(report.spoolDropped, 0);
  });

  test("the same record is dropped when the project sets a one-day window", () => {
    const home = newDir("tlc-retain-home-");
    const project = newDir("tlc-retain-project-");
    mkdirSync(projectStateDir(project), { recursive: true });
    writeObsPolicy(project, { retentionDays: 1 });
    seedSpool(home, project, 2);
    const result = run("tools/obs-cli.ts", ["prune", "--json"], { TLC_HOME: home, TLC_PROJECT_DIR: project });
    const report = JSON.parse(result.stdout) as { retentionDays: number; spoolDropped: number };
    assert.equal(report.retentionDays, 1);
    assert.equal(report.spoolDropped, 1);
  });
});

describe("the routing eval runner", () => {
  test("exits 0 and says why when no API key is present", () => {
    const result = spawnSync(process.execPath, [join(repoRoot, "tools", "dev", "eval-skill-triggers.ts")], {
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ANTHROPIC_API_KEY is not set/);
  });

  test("the same skip is machine-readable under --json", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "tools", "dev", "eval-skill-triggers.ts"), "--json"],
      { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } },
    );
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout) as { skipped: boolean };
    assert.equal(report.skipped, true);
  });
});
