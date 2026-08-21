import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildTestSteps, TEST_ENV_IMPORT } from "../../bin/tlc-cli.ts";
import {
  claudeConfigDir,
  conventionalRuntimeHome,
  cursorConfigDir,
  launcherBinDir,
} from "../../src/platform/paths.ts";
import { PROJECT_SCOPED_ENV, PUBLISHED_ENV, REDIRECTED_ENV, RUNTIME_SCOPED_ENV } from "../test-env.names.mjs";

// invariant: the names come from test-env.names.mjs, which has no side effect. Importing test-env.mjs here
// would run its delete loop, so the guard would clean the environment it is asserting about and could never
// fail — verified: it passed with the variable set and the --import absent.
// hazard: this is the guard for a defect that cost four blocked stop loops and 22 failures across five
// unrelated subsystems. The suite read CLAUDE_PROJECT_DIR from whatever launched it, so a fixture in a temp
// directory resolved against the real repository. It passed from a shell and failed from inside a hook.
test("no project-identifying variable reaches a test", () => {
  for (const name of PROJECT_SCOPED_ENV) {
    assert.equal(
      process.env[name],
      undefined,
      `${name} leaked into the suite. The runner must be launched with ${TEST_ENV_IMPORT.join(" ")} — see tools/test-env.mjs.`,
    );
  }
});

// why: asserting the effect alone would pass if someone dropped the --import while running from a clean shell,
// and the 22 failures would come back the next time a hook ran the gate. The wiring is the thing that decays.
test("both suites are launched through the setup module", () => {
  const suites = buildTestSteps().filter((step) => step.label.endsWith("suite"));

  assert.equal(suites.length, 2, "expected a src suite and a tools suite");
  for (const suite of suites) {
    assert.ok(
      suite.args.join(" ").includes(TEST_ENV_IMPORT.join(" ")),
      `${suite.label} does not load the hermetic setup module`,
    );
  }
});

/**
 * invariant: `TLC_HOME` is redirected, not deleted. Deleting it would send every test at the developer's real
 * `~/.tlc/harness`, which is the opposite of hermetic; an empty temp directory is a runtime home that exists and
 * contains nothing.
 *
 * hazard: this variable was deliberately left alone, on the reasoning that it names which runtime and that CI sets
 * it on purpose. That held only while nothing machine-wide lived under it. The global lesson tier does, so a test
 * calling `allLessons` without pinning the home read whichever lessons the developer had promoted — green on a
 * fresh machine, green in CI, red on mine the moment I promoted five ([/decisions/ad-042.md](/decisions/ad-042.md)).
 */
test("TLC_HOME is redirected to an empty directory rather than deleted", () => {
  assert.ok(
    !PROJECT_SCOPED_ENV.includes("TLC_HOME"),
    "it is redirected, so it must not be in the delete list",
  );
  const home = process.env.TLC_HOME;
  assert.ok(home, "the suite must run with a runtime home");
  assert.notEqual(home, join(homedir(), ".tlc", "harness"), "the suite must not read the real runtime home");
  assert.equal(existsSync(join(home, "state", "lessons.json")), false, "the runtime home must start empty");
});

// hazard: the assertion above reads ambient state, so it would pass even if the module were inert while running
// from a shell that happened to have no TLC_HOME. This spawns a child that *does* have one and asks whether the
// module moved it — the same discipline the delete-loop probe below follows.
test("the setup module redirects a TLC_HOME that is already set", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tools/test-env.mjs",
      "--input-type=module",
      "--eval",
      'if (process.env.TLC_HOME === "/leaked-runtime") { process.exit(9); }',
    ],
    {
      cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      env: { ...process.env, TLC_HOME: "/leaked-runtime" } as NodeJS.ProcessEnv,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, `TLC_HOME survived the setup module: ${result.stderr}`);
});

// hazard: the assertion above only fires when the variable is actually set, so from a clean shell it passes
// even if the module were inert — the discrimination sensor proved exactly that by emptying the delete loop
// with no test failing. This spawns a child with the variable set and asks whether the module removes it, which
// tests the mechanism instead of the ambient state.
test("the setup module removes each variable in a process that has them", () => {
  const probe = PROJECT_SCOPED_ENV.map(
    (name) => `if (process.env[${JSON.stringify(name)}] !== undefined) { process.exit(9); }`,
  ).join("\n");

  const result = spawnSync(
    process.execPath,
    ["--import", "./tools/test-env.mjs", "--input-type=module", "--eval", probe],
    {
      cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      env: Object.fromEntries([
        ...Object.entries(process.env),
        ...PROJECT_SCOPED_ENV.map((name) => [name, "/leaked"]),
      ]) as NodeJS.ProcessEnv,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, `a variable survived the setup module: ${result.stderr}`);
});

/**
 * hazard: redirecting `TLC_HOME` was not enough. The installer honours it only when `TLC_HOME_FROM_ENV` says an
 * operator chose it, and `TLC_ORIGIN` names the copy to install *from* — both of which the CLI sets for every
 * child, and the gate runs the suite through the CLI. So a test that spawned a shipped bundle had it resolve the
 * real conventional home with the real repository as its source. On a machine installed with `--link` that home
 * is a symlink to the checkout: the install deleted this repository's own `bin/` in the middle of its own gate,
 * and four suites then failed for want of a launcher ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
test("no variable naming a runtime copy reaches a test", () => {
  for (const name of RUNTIME_SCOPED_ENV) {
    assert.equal(
      process.env[name],
      undefined,
      `${name} leaked into the suite. The runner must be launched with ${TEST_ENV_IMPORT.join(" ")} — see tools/test-env.mjs.`,
    );
  }
});

/**
 * invariant: and the destination is redirected rather than deleted, for the same reason `TLC_HOME` is. Deleting it
 * sends an install that a test spawns at the conventional home, which is the machine's.
 */
/**
 * hazard: this built the real paths from `homedir()`, which by this point answers the fake — so the assertion whose
 * message says *points at a real path on this machine* could no longer see one. The setup captures the real home
 * before redirecting, and this compares against that ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
test("every destination variable is redirected somewhere throwaway", () => {
  const realHome = process.env.TLC_TEST_REAL_HOME;
  assert.ok(realHome, "the setup must publish the home it replaced, or this guard cannot see a real path");
  const real = [join(realHome, ".tlc", "harness"), join(realHome, ".local", "bin")];

  for (const name of REDIRECTED_ENV) {
    const value = process.env[name];
    assert.ok(value, `${name} must be set to a throwaway path, not deleted`);
    assert.ok(!real.includes(value), `${name} points at a real path on this machine: ${value}`);
  }
});

// why a child: the two assertions above read ambient state, so they would pass with the module inert in a shell
// that never had these set. This is the probe that fails when the scrubbing goes away.
test("the setup module scrubs a runtime-scoped variable that is already set", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tools/test-env.mjs",
      "-e",
      "console.log(JSON.stringify([process.env.TLC_ORIGIN ?? null, process.env.TLC_HOME_FROM_ENV ?? null]))",
    ],
    {
      encoding: "utf8",
      cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      env: { ...process.env, TLC_ORIGIN: "/somewhere/real", TLC_HOME_FROM_ENV: "0" },
    },
  );

  assert.deepEqual(JSON.parse(result.stdout.trim()), [null, null], result.stderr);
});

/**
 * hazard: `wireRuntime` links `tlc` into `TLC_BIN_DIR`, default `~/.local/bin`. The suite calls it with a temp
 * runtime, so a test wrote a launcher into the operator's real bin directory pointing at a temp directory the same
 * test then removed — the live `tlc` became a dangling link into `/tmp`
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */

/**
 * The isolation asserted directly, not through its effect.
 *
 * hazard: every guard before this one asserted that a *variable* was redirected. None asserted that the API the
 * production code actually calls answers the redirected value — so a name added to the list without the setup
 * honouring it, or a path that reads `homedir()` instead of the variable, would pass. The published pattern for
 * this is to assert on the resolver: that `homedir()` is the fake, that it differs from the real one, and that the
 * real target does not exist ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
test("the home the production code resolves is the fake one", () => {
  const home = homedir();

  assert.equal(home, process.env.HOME, "os.homedir() must answer the redirected value");
  assert.match(home, /tlc-test-home-dir-/, `not a throwaway home: ${home}`);
});

test("every path derived from the home lands inside it", () => {
  const home = homedir();

  for (const [label, path] of [
    ["runtime home", conventionalRuntimeHome()],
    ["claude config", claudeConfigDir()],
    ["cursor config", cursorConfigDir()],
  ] as const) {
    assert.ok(path.startsWith(home), `${label} escaped the fake home: ${path}`);
  }
});

/** invariant: the launcher bin directory is redirected on its own, so it is throwaway without being under the home. */
test("the launcher bin directory is a throwaway of its own", () => {
  assert.match(launcherBinDir(), /tlc-test-bin-/, launcherBinDir());
});

/**
 * hazard: the assertions above read ambient state, so they would pass with the setup inert in a shell that happened
 * to have no `HOME`. This spawns a child that *does* have one and asks whether the module moved it.
 */
test("the setup module redirects a home that is already set", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tools/test-env.mjs",
      "-e",
      "console.log(JSON.stringify([require('node:os').homedir(), process.env.CURSOR_CONFIG_DIR]))",
    ],
    {
      encoding: "utf8",
      cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      env: { ...process.env, HOME: "/definitely/the/real/home", CURSOR_CONFIG_DIR: "/real/cursor" },
    },
  );
  const [home, cursor] = JSON.parse(result.stdout.trim()) as [string, string];

  assert.notEqual(home, "/definitely/the/real/home", result.stderr);
  assert.notEqual(cursor, "/real/cursor", result.stderr);
});

/**
 * invariant: nothing a suite writes can reach the operator's real directories, asserted as a negative — the shape
 * the published isolation pattern uses, because a positive assertion about the fake says nothing about the real.
 */
/**
 * hazard: this read `TLC_TEST_REAL_HOME`, which nothing set — so it returned on its first line every single run. The
 * one test written as the negative of the whole claim never ran ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
test("the real provider directories are not what a test would write to", () => {
  const realHome = process.env.TLC_TEST_REAL_HOME;
  assert.ok(realHome, "the setup must publish the home it replaced, or this assertion is vacuous");
  for (const path of [claudeConfigDir(), cursorConfigDir(), conventionalRuntimeHome()]) {
    assert.ok(!path.startsWith(realHome), `${path} is inside the real home ${realHome}`);
  }
});

/**
 * The list and the effect cannot drift.
 *
 * hazard: `REDIRECTED_ENV` is read by the guards above, and the redirect itself is a separate assignment in the
 * setup module. So removing a name from the list made the guards check *fewer* names and everything stayed green —
 * a mutation that did exactly that survived. Declared and done are two facts, and this is the one that pairs them
 * ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
test("every variable the setup writes is declared, and every declared one is written", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "test-env.mjs"), "utf8");
  const assigned = [...source.matchAll(/process\.env\.([A-Z_]+)\s*=/g)].map((match) => match[1] as string);

  assert.deepEqual([...new Set(assigned)].sort(), [...REDIRECTED_ENV, ...PUBLISHED_ENV].sort());
});
