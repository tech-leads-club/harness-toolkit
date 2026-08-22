import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeSeparators } from "../../src/platform/sanitize.ts";
import {
  attempts,
  parsePackReport,
  probeEnv,
  probeSteps,
  registrySpec,
  runSteps,
} from "../dev/verify-package.mjs";
import { REDIRECTED_ENV } from "../test-env.names.mjs";

/**
 * hazard: an independent review deleted the `tlc harness doctor` line from the probe and every test stayed green,
 * because the assertion read the script's *source* for that text — and the version check on the next line contains
 * it too. Then, with a `doctor` forced to exit 1, the release would have proceeded: the commands were joined with
 * ` && ` and ended in `|| echo`, and `&&` and `||` share precedence, so any failure fell into the `||` and the
 * compound exited 0 ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
describe("probeSteps", () => {
  const steps = probeSteps("/tmp/pkg-1.0.0.tgz", "1.0.0") as {
    label: string;
    command: string;
    expect?: string;
  }[];
  const commands = steps.map((step) => step.command);

  /** invariant: asserted element by element, so a deleted step cannot hide inside another one's text. */
  test("the clean room installs, then drives every command an operator would", () => {
    assert.ok(commands.includes("tlc harness version"), commands.join(" | "));
    assert.ok(commands.includes("tlc harness install"), commands.join(" | "));
    assert.ok(commands.includes("tlc harness doctor"), commands.join(" | "));
  });

  test("it installs the tarball it was given, the way npx would", () => {
    assert.equal(steps[0]?.command, 'npm i -g "/tmp/pkg-1.0.0.tgz" --silent');
  });

  /**
   * invariant: the version is read back out of the installed runtime, and as an expectation on captured output
   * rather than a `grep` pipeline — `grep` is not a command on Windows, and a pipeline's exit status was the other
   * half of the swallowed-failure defect ([/decisions/ad-103.md](/decisions/ad-103.md)).
   */
  test("and reads the version back out of the installed runtime", () => {
    const doctor = steps.find((step) => step.command === "tlc harness doctor");

    assert.equal(doctor?.expect, "harness version — 1.0.0");
  });

  /** invariant: no step composes a shell — one process per step is what removed the swallowed-failure class. */
  test("no step carries a shell operator", () => {
    for (const command of commands) {
      assert.doesNotMatch(command, /&&|\|\||\|/, command);
    }
  });
});

/**
 * The composition rule, executed rather than read: the first failure must stop the run, and a step that exits 0
 * while reporting the wrong thing must fail too.
 */
describe("runSteps", () => {
  /**
   * invariant: "nothing after the failure runs" is proven by a step that would leave a file behind, not by an
   * assertion about a variable this test controls.
   */
  test("a failure stops the run and names the step that failed", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "tlc-steps-")), "reached");
    const result = runSteps(
      [
        { label: "first", command: 'node -e "console.log(1)"' },
        { label: "the one that fails", command: 'node -e "process.exit(3)"' },
        {
          label: "unreachable",
          command: `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${marker}`,
        },
      ],
      {},
    ) as { ok: boolean; step?: { label: string }; reason?: string };

    assert.equal(result.ok, false);
    assert.equal(result.step?.label, "the one that fails");
    assert.match(result.reason ?? "", /exit 3/);
    assert.equal(existsSync(marker), false, "nothing after the failure may run");
  });

  /**
   * hazard: this is the case a chained shell script could not see at all. `doctor` exits 0 while reporting a
   * version that is not the one being published — a shim resolving an older runtime does exactly that.
   */
  test("a step that exits 0 with the wrong output fails", () => {
    const result = runSteps(
      [{ label: "wrong version", command: "node -e \"console.log('0.0.1')\"", expect: "9.9.9" }],
      {},
    ) as { ok: boolean; reason?: string };

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /does not contain/);
  });

  test("and a clean run is ok", () => {
    const result = runSteps(
      [{ label: "fine", command: "node -e \"console.log('ready')\"", expect: "ready" }],
      {},
    ) as {
      ok: boolean;
    };

    assert.equal(result.ok, true);
  });
});

/**
 * hazard: `prepack` runs the bundler, so this stdout is not only npm's report — and the bundler colours its output,
 * which means an ANSI escape's own `[` is what a scan for the first bracket finds
 * ([/decisions/ad-103.md](/decisions/ad-103.md)).
 */
describe("parsePackReport", () => {
  const report =
    '{\n  "@scope/pkg": {\n    "filename": "scope-pkg-1.0.0.tgz",\n    "files": [{ "path": "bin/tlc" }]\n  }\n}';

  test("noise before the report does not hide it", () => {
    const parsed = parsePackReport(
      `tlc-build → /repo/dist\n[32mBundled 125 modules in 9ms[0m\n${report}`,
    ) as {
      filename: string;
    };

    assert.equal(parsed.filename, "scope-pkg-1.0.0.tgz");
  });

  test("the array shape npm also uses is read the same way", () => {
    const parsed = parsePackReport('noise\n[\n  { "filename": "a-1.0.0.tgz" }\n]') as { filename: string };

    assert.equal(parsed.filename, "a-1.0.0.tgz");
  });

  test("no report at all is null rather than a throw", () => {
    assert.equal(parsePackReport("npm error code E404\n"), null);
  });
});

/**
 * hazard: the probe's environment was `{...process.env, HOME, USERPROFILE}`. `tlc harness install` writes provider
 * hooks into whatever `CLAUDE_CONFIG_DIR` and `CURSOR_CONFIG_DIR` resolve to, and those were inherited from the
 * shell — so running this script inside an agent session rewrote the operator's real `settings.json` to point at a
 * temp directory the script then deleted, and every hook on that machine failed to load. The suite's own list of
 * these names already existed ([/decisions/ad-102.md](/decisions/ad-102.md), [/decisions/ad-103.md](/decisions/ad-103.md)).
 */
describe("probeEnv", () => {
  const real = {
    HOME: "/home/operator",
    USERPROFILE: "C:\\Users\\operator",
    CLAUDE_CONFIG_DIR: "/home/operator/.claude-work",
    CURSOR_CONFIG_DIR: "/home/operator/.cursor",
    TLC_HOME: "/home/operator/.tlc/harness",
    TLC_INSTALL_DEST: "/home/operator/.tlc/harness",
    TLC_BIN_DIR: "/home/operator/.local/bin",
    TLC_ORIGIN: "/repo",
    TLC_HOME_FROM_ENV: "1",
    CLAUDE_PROJECT_DIR: "/repo",
    CURSOR_PROJECT_DIR: "/repo",
    TLC_PROJECT_DIR: "/repo",
    PATH: "/usr/bin",
  };
  const env = probeEnv(real, "/tmp/prefix", "/tmp/home") as Record<string, string | undefined>;

  /** invariant: nothing the child can write may name a path outside the throwaway. */
  test("no destination still points at the operator's own paths", () => {
    for (const [name, value] of Object.entries(env)) {
      if (name === "PATH") {
        continue;
      }
      assert.doesNotMatch(value ?? "", /operator/, `${name} still names the operator's own path`);
    }
  });

  test("the provider config directories are redirected, not inherited", () => {
    assert.equal(env.CLAUDE_CONFIG_DIR, join("/tmp/home", ".claude"));
    assert.equal(env.CURSOR_CONFIG_DIR, join("/tmp/home", ".cursor"));
  });

  test("which-project and which-source names are removed rather than pointed somewhere", () => {
    for (const name of ["CLAUDE_PROJECT_DIR", "CURSOR_PROJECT_DIR", "TLC_PROJECT_DIR", "TLC_ORIGIN"]) {
      assert.equal(env[name], undefined, `${name} survived`);
    }
  });

  /**
   * hazard: pointing these at the throwaway made the launcher look for the runtime there — an empty directory,
   * because `install` has not run yet at that step — and the probe died with "dist/tlc-cli.mjs is missing" on all
   * three platforms. An installed command has to resolve its own runtime out of the package it came from, and any
   * value here answers that question for it ([/decisions/ad-103.md](/decisions/ad-103.md)).
   */
  test("the names that would tell the launcher where its runtime is are absent, not redirected", () => {
    assert.equal(env.TLC_HOME, undefined);
    assert.equal(env.TLC_INSTALL_DEST, undefined);
  });

  /**
   * invariant: every name the suite declares as a redirected destination is either inside the throwaway or
   * deliberately absent. A name added to that list and handled by neither would keep pointing at the operator's
   * own path.
   */
  test("every declared destination is covered", () => {
    for (const name of REDIRECTED_ENV) {
      const value = env[name];
      // why normalised: `join` spells these with the platform's separator, so a `/tmp/` prefix test is an
      // assertion about the developer's platform rather than about the value — which is the third time this
      // separator class has been caught by the Windows leg ([/decisions/ad-102.md](/decisions/ad-102.md)).
      assert.ok(
        value === undefined || normalizeSeparators(value).startsWith("/tmp/"),
        `${name} is neither absent nor inside the throwaway: ${value}`,
      );
    }
  });

  test("and the installed command is found before anything already on PATH", () => {
    assert.match(env.PATH ?? "", /^\/tmp\/prefix/);
  });
});

/**
 * The post-publish probe reads its target and its patience from argv, and both have a failure mode that is silent:
 * a spec with no version would drive whatever `latest` happens to be, and a retry count nothing parses would make
 * the flag in the workflow decorative ([/decisions/ad-103.md](/decisions/ad-103.md)).
 */
describe("the published-version probe", () => {
  test("no --from means the local tarball, not the registry", () => {
    assert.equal(registrySpec(["node", "verify-package.mjs"]), null);
  });

  test("a spec carries the version it will assert on", () => {
    const parsed = registrySpec(["--from", "@scope/pkg@1.2.3"]) as { spec: string; version: string };

    assert.equal(parsed.spec, "@scope/pkg@1.2.3");
    assert.equal(parsed.version, "1.2.3");
  });

  test("retries are only what argv actually says", () => {
    assert.equal(attempts(["--retries", "6"]), 6);
    assert.equal(attempts(["--retries", "nonsense"]), 0);
    assert.equal(attempts(["--from", "a@1"]), 0);
  });
});

/**
 * hazard: this module's main flow ran at module scope, so importing it to test the steps executed `npm pack` and the
 * whole probe. It passed locally and failed the macOS leg of CI with a file-level error at line 1 — the module, not
 * a test. The rule already existed: no library module self-executes
 * ([/decisions/ad-098.md](/decisions/ad-098.md), [/decisions/ad-102.md](/decisions/ad-102.md)).
 */
test("importing the module runs nothing", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "dev", "verify-package.mjs"),
    "utf8",
  );
  const guard = source.indexOf("if (import.meta.main) {");

  assert.ok(guard > 0, "the main flow must sit behind an import.meta.main guard");
  // why unindented: an indented declaration is inside a function, which is where spawning belongs. Only a
  // module-scope one executes on import, and that is the defect this rail exists for.
  assert.doesNotMatch(source.slice(0, guard), /^(?:const|let)\s+\w+\s*=\s*(?:run|spawnSync)\(/m);
});
