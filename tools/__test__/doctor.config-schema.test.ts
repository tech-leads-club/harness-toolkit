import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { projectConfigPath } from "../../src/platform/paths.ts";
import { checkConfigKeys } from "../doctor.ts";

const cleanup: string[] = [];

// hazard: resolvedWithoutProjectTier() falls back to the runtime home's config.json, so an unsandboxed run reads
// the contributor's own machine config — see the identical note in doctor.allowlist.test.ts
// ([/decisions/ad-095.md](/decisions/ad-095.md)).
let runtimeSandbox: string;
let previousHome: string | undefined;

before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-doctor-schema-home-"));
  previousHome = process.env.TLC_HOME;
  process.env.TLC_HOME = runtimeSandbox;
});

after(() => {
  if (previousHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = previousHome;
  }
  rmSync(runtimeSandbox, { recursive: true, force: true });
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-doctor-schema-"));
  cleanup.push(root);
  return root;
}

function writeRawConfig(root: string, text: string): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test("no project config file present reports nothing", () => {
  assert.deepEqual(checkConfigKeys(projectRoot()), []);
});

// why: this exact shape is the live defect this feature was found from — this repo's own config
// carried a top-level format block nothing reads.
test("a config with an unknown key names it", () => {
  const root = projectRoot();
  writeRawConfig(root, JSON.stringify({ version: 1, format: { enabled: true, command: ["biome"] } }));

  const checks = checkConfigKeys(root);
  const unknown = checks.find((c) => c.name === "project policy has an unknown key");
  assert.ok(unknown, "expected an unknown-key check");
  assert.equal(unknown?.level, "warn");
  assert.match(unknown?.detail ?? "", /format/);
});

test("a config with a type mismatch names the expected and actual type", () => {
  const root = projectRoot();
  writeRawConfig(root, JSON.stringify({ version: 1, mode: 1 }));

  const checks = checkConfigKeys(root);
  const mismatch = checks.find((c) => c.name === "project policy has a type mismatch");
  assert.ok(mismatch, "expected a type-mismatch check");
  assert.equal(mismatch?.level, "warn");
  assert.match(mismatch?.detail ?? "", /mode \(expected string, got number\)/);
});

// why: distinct from absence because a trailing comma silently drops the whole project tier to
// defaults today (readJsonFile keeps that forgiving on the hot path) — doctor names the difference.
test("a config that fails to parse is reported distinctly from an absent one", () => {
  const root = projectRoot();
  writeRawConfig(root, "{ version: 1, }");

  const checks = checkConfigKeys(root);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.name, "project policy parses");
  assert.equal(checks[0]?.level, "warn");
  assert.match(checks[0]?.detail ?? "", /failed to parse/);
  assert.doesNotMatch(checks[0]?.detail ?? "", /no project config file present/);
});

test("a clean config with only real keys and matching types reports nothing", () => {
  const root = projectRoot();
  writeRawConfig(root, JSON.stringify({ version: 1, mode: "solo", codePaths: ["src"] }));

  assert.deepEqual(checkConfigKeys(root), []);
});

// why: found by running doctor against this repo's own live config — projectName is a real, optional
// Policy field DEFAULTS never sets, so it read as unknown alongside the genuinely unknown format key
// until policy.shadow.ts's walk exempted it at the root.
test("projectName alone is not reported as an unknown key", () => {
  const root = projectRoot();
  writeRawConfig(root, JSON.stringify({ version: 1, projectName: "tlc-agent-harness" }));

  assert.deepEqual(checkConfigKeys(root), []);
});

test("$schema on a clean config is not itself reported as an unknown key", () => {
  const root = projectRoot();
  writeRawConfig(
    root,
    JSON.stringify({ $schema: "https://unpkg.com/example/schema.json", version: 1, mode: "solo" }),
  );

  assert.deepEqual(checkConfigKeys(root), []);
});
