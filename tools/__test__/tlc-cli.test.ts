import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  acceptPolicy,
  attestJson,
  attestText,
  buildTestSteps,
  ensureFlagsDir,
  focusFlagPath,
  gatesPaused,
  globalPackageRoot,
  grindFlagPath,
  grindOn,
  helpText,
  KNIP_EXPORTS_CEILING,
  linkedRuntimeMessage,
  modeFilePath,
  npmRootFailureMessage,
  npmSyncPlan,
  pairedFlagPath,
  pendingText,
  pendingUpdate,
  policyJson,
  policyText,
  pricesHelpText,
  readMode,
  resetFailureMessage,
  resetStuckState,
  resolveExecutable,
  resolveProjectRoot,
  route,
  runTestSteps,
  runtimeRevision,
  setGateCommand,
  setGrind,
  setMode,
  setPaused,
  skipFlagPath,
  statusJson,
  statusText,
  UsageError,
  unmanagedRuntimeMessage,
  wireRuntime,
} from "../../bin/tlc-cli.ts";
import { coreFacade } from "../../src/core/index.ts";
import { flagsDir, loopsDir, projectConfigPath, projectStateDir } from "../../src/platform/paths.ts";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-cli-"));
}

const cleanupRoots: string[] = [];

function newRoot(): string {
  const root = fixtureRoot();
  cleanupRoots.push(root);
  return root;
}

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("resolveProjectRoot", () => {
  const original = process.env.TLC_PROJECT_DIR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TLC_PROJECT_DIR;
    } else {
      process.env.TLC_PROJECT_DIR = original;
    }
  });

  test("honors TLC_PROJECT_DIR when set", () => {
    process.env.TLC_PROJECT_DIR = "/some/project";
    assert.equal(resolveProjectRoot(), "/some/project");
  });

  test("falls back to process.cwd() when unset", () => {
    delete process.env.TLC_PROJECT_DIR;
    assert.equal(resolveProjectRoot(), process.cwd());
  });
});

describe("flag file paths", () => {
  test("grindFlagPath lands under state/flags/grind-on", () => {
    const root = newRoot();
    assert.equal(grindFlagPath(root), join(flagsDir(root), "grind-on"));
    assert.ok(grindFlagPath(root).includes(join("state", "flags", "grind-on")));
  });

  test("skipFlagPath lands under state/flags/skip-verify", () => {
    const root = newRoot();
    assert.equal(skipFlagPath(root), join(flagsDir(root), "skip-verify"));
  });

  // invariant: a posture flag file is named after its posture, with no second spelling anywhere in the chain
  // from the typed word to the file on disk.
  test("the posture flag files are named after their postures", () => {
    const root = newRoot();
    assert.equal(focusFlagPath(root), join(flagsDir(root), "focus"));
    assert.equal(pairedFlagPath(root), join(flagsDir(root), "paired"));
  });

  test("modeFilePath lands under state/ but not state/flags/", () => {
    const root = newRoot();
    assert.equal(modeFilePath(root), join(projectStateDir(root), "harness-mode"));
    assert.equal(modeFilePath(root).includes(join("state", "flags")), false);
  });
});

describe("setGrind", () => {
  test("on writes grind-on flag file under state/flags/", () => {
    const root = newRoot();
    setGrind(root, true);
    assert.ok(existsSync(grindFlagPath(root)));
  });

  test("off removes an existing grind-on flag file", () => {
    const root = newRoot();
    setGrind(root, true);
    setGrind(root, false);
    assert.equal(existsSync(grindFlagPath(root)), false);
  });

  test("off is a no-op when no flag file exists", () => {
    const root = newRoot();
    assert.doesNotThrow(() => setGrind(root, false));
    assert.equal(existsSync(grindFlagPath(root)), false);
  });
});

describe("setPaused", () => {
  test("on writes the skip-verify flag file", () => {
    const root = newRoot();
    setPaused(root, true);
    assert.ok(existsSync(skipFlagPath(root)));
  });

  test("off removes the skip-verify flag file", () => {
    const root = newRoot();
    setPaused(root, true);
    setPaused(root, false);
    assert.equal(existsSync(skipFlagPath(root)), false);
  });
});

describe("resetStuckState", () => {
  test("clears a project's blockers and reports it", async () => {
    const root = newRoot();
    await coreFacade.handoff.patchHandoff(root, "claude", {
      slice: { blockers: "Grind cap hit (3 stop loops).", last_failure_category: "budget" },
    });
    const summary = await resetStuckState(root);
    assert.match(summary, /cleared blockers for: claude/);
    const resolved = coreFacade.handoff.readHandoff(root, "claude");
    assert.equal(resolved.blockers, undefined);
  });

  test("removes grind-loop counter files", async () => {
    const root = newRoot();
    mkdirSync(loopsDir(root), { recursive: true });
    writeFileSync(join(loopsDir(root), "claude-session-1.json"), "{}");
    const summary = await resetStuckState(root);
    assert.match(summary, /reset 1 grind-loop counter/);
    assert.equal(existsSync(loopsDir(root)), false);
  });

  test("reports nothing stuck when there is no blocker and no loop state", async () => {
    const root = newRoot();
    const summary = await resetStuckState(root);
    assert.equal(summary, "nothing stuck — no blockers and no grind-loop state to clear");
  });
});

describe("setMode", () => {
  test("solo writes 'solo' to the mode file", () => {
    const root = newRoot();
    setMode(root, "solo");
    assert.equal(readFileSync(modeFilePath(root), "utf8").trim(), "solo");
  });

  test("paired writes 'paired' to the mode file", () => {
    const root = newRoot();
    setMode(root, "paired");
    assert.equal(readFileSync(modeFilePath(root), "utf8").trim(), "paired");
  });

  test("focus writes 'focus' to the mode file", () => {
    const root = newRoot();
    setMode(root, "focus");
    assert.equal(readFileSync(modeFilePath(root), "utf8").trim(), "focus");
  });

  // hazard: `focus` used to be mapped onto a second spelling on the way to disk, and two more aliases pointed at
  // the same place. Every alias is a word the operator can type that the config field cannot hold, which is the
  // measured bug: the documented word matched no branch and produced a policy with no posture at all.
  test("a word that is not one of the three postures throws and writes nothing", () => {
    const root = newRoot();
    for (const rejected of ["heads-down", "heads", "bogus", "", "sol"]) {
      assert.throws(() => setMode(root, rejected), UsageError, rejected);
      assert.equal(existsSync(modeFilePath(root)), false, rejected);
    }
  });

  test("the refusal names the three accepted words, so the fix is readable from the error", () => {
    const root = newRoot();
    assert.throws(() => setMode(root, "heads-down"), /paired \| solo \| focus/);
  });

  // why: the confirmation used to announce grind, which posture no longer touches. A line that claims a
  // capability the command did not set is the AD-020 defect in the operator's own output.
  test("no posture confirmation claims grind", () => {
    const root = newRoot();
    for (const mode of ["paired", "solo", "focus"]) {
      assert.doesNotMatch(setMode(root, mode), /grind/i, mode);
    }
  });
});

describe("readMode", () => {
  test("defaults to 'solo' with no mode file or flags", () => {
    const root = newRoot();
    assert.equal(readMode(root), "solo");
  });

  test("reads 'paired' from the mode file", () => {
    const root = newRoot();
    setMode(root, "paired");
    assert.equal(readMode(root), "paired");
  });

  // invariant: what the operator types is what the loader reads back. This round-trip is the whole point of
  // having one word per posture — it is the assertion an alias layer would pass while the config field did not.
  test("each of the three postures round-trips through the mode file", () => {
    const root = newRoot();
    for (const mode of ["paired", "solo", "focus"]) {
      setMode(root, mode);
      assert.equal(readMode(root), mode);
    }
  });

  test("falls back to the focus flag file when no mode file exists", () => {
    const root = newRoot();
    setGrind(root, false);
    mkdirSync(flagsDir(root), { recursive: true });
    writeFileSync(focusFlagPath(root), "");
    assert.equal(readMode(root), "focus");
  });

  test("falls back to the paired flag file when no mode file exists", () => {
    const root = newRoot();
    mkdirSync(flagsDir(root), { recursive: true });
    writeFileSync(pairedFlagPath(root), "");
    assert.equal(readMode(root), "paired");
  });
});

describe("grindOn / gatesPaused", () => {
  test("grindOn is true once the grind-on flag is set", () => {
    const root = newRoot();
    assert.equal(grindOn(root), false);
    setGrind(root, true);
    assert.equal(grindOn(root), true);
  });

  // invariant: verification does not move when posture moves. The deepest posture used to force grind on, so a
  // surfacing preference silently switched on a capability with its own flag and its own documented trade-off.
  // This asserts the inverse of what the old test asserted, because the contract changed by decision.
  test("no posture switches grind on by itself", () => {
    const root = newRoot();
    for (const mode of ["paired", "solo", "focus"]) {
      setMode(root, mode);
      assert.equal(grindOn(root), false, mode);
    }
  });

  test("gatesPaused reflects the skip-verify flag", () => {
    const root = newRoot();
    assert.equal(gatesPaused(root), false);
    setPaused(root, true);
    assert.equal(gatesPaused(root), true);
  });
});

describe("statusText / help text", () => {
  test("statusText names the project root and current mode", () => {
    const root = newRoot();
    const text = statusText(root);
    assert.ok(text.includes(root));
    assert.match(text, /mode:\s+.*solo/);
  });

  test("statusJson carries the same three facts as data, with no prose", () => {
    const root = newRoot();
    assert.deepEqual(statusJson(root), {
      root,
      mode: "solo",
      modeOrigin: "config",
      grind: false,
      gatesPaused: false,
    });
  });

  test("statusJson tracks grind and pause state", () => {
    const root = newRoot();
    setGrind(root, true);
    setPaused(root, true);
    assert.deepEqual(statusJson(root), {
      root,
      mode: "solo",
      modeOrigin: "config",
      grind: true,
      gatesPaused: true,
    });
  });

  test("statusJson reports the posture the mode file holds, and reports grind separately", () => {
    const root = newRoot();
    setMode(root, "focus");
    const report = statusJson(root);
    assert.equal(report.mode, "focus");
    assert.equal(report.modeOrigin, "file");
    assert.equal(report.grind, false);
  });

  // why: a first-class verb, because nobody who cannot tell the harness from the model remembers that the answer
  // lives under `obs` ([/decisions/ad-062.md](/decisions/ad-062.md)).
  test("why routes to the obs entry with its subcommand and count", () => {
    assert.deepEqual(route(["why"]), { kind: "entry", entry: "obs-cli", args: ["why"] });
    assert.deepEqual(route(["why", "25"]), { kind: "entry", entry: "obs-cli", args: ["why", "25"] });
  });

  test("uninstall routes to its own entry and carries the flags through untouched", () => {
    assert.deepEqual(route(["uninstall"]), { kind: "entry", entry: "uninstall-runtime", args: [] });
    assert.deepEqual(route(["uninstall", "--yes", "--purge"]), {
      kind: "entry",
      entry: "uninstall-runtime",
      args: ["--yes", "--purge"],
    });
  });

  // why: the exit has to be as findable as the entrance, and help is where an operator looks.
  test("helpText names uninstall next to install", () => {
    const text = helpText();
    assert.ok(text.includes("tlc harness uninstall"));
  });

  test("helpText names 'tlc harness', never bare 'harness'", () => {
    const text = helpText();
    assert.ok(text.includes("tlc harness"));
    const bareHarness = text.match(/(?<!tlc )\bharness\b/);
    assert.equal(bareHarness, null);
  });

  test("pricesHelpText names 'tlc harness', never bare 'harness'", () => {
    const text = pricesHelpText();
    assert.ok(text.includes("tlc harness"));
    const bareHarness = text.match(/(?<!tlc )\bharness\b/);
    assert.equal(bareHarness, null);
  });
});

describe("route — dispatch table", () => {
  test("defaults to status when no subcommand is given", () => {
    assert.deepEqual(route([]), { kind: "status" });
  });

  test("doctor forwards its own arguments to the entry", () => {
    assert.deepEqual(route(["doctor", "--json"]), {
      kind: "entry",
      entry: "doctor",
      args: ["--json"],
    });
  });

  test("routes doctor, build, update, and test", () => {
    assert.deepEqual(route(["doctor"]), { kind: "entry", entry: "doctor", args: [] });
    assert.deepEqual(route(["build"]), { kind: "build" });
    assert.deepEqual(route(["update"]), { kind: "update" });
    assert.deepEqual(route(["test"]), { kind: "test" });
  });

  test("routes grind on/off and rejects a bad argument", () => {
    assert.deepEqual(route(["grind", "on"]), { kind: "grind", on: true });
    assert.deepEqual(route(["grind", "off"]), { kind: "grind", on: false });
    assert.throws(() => route(["grind", "sideways"]), UsageError);
  });

  test("routes pause and resume", () => {
    assert.deepEqual(route(["pause"]), { kind: "pause" });
    assert.deepEqual(route(["resume"]), { kind: "resume" });
  });

  test("routes reset", () => {
    assert.deepEqual(route(["reset"]), { kind: "reset" });
  });

  test("mode requires an argument", () => {
    assert.throws(() => route(["mode"]), UsageError);
    assert.deepEqual(route(["mode", "paired"]), { kind: "mode", value: "paired" });
  });

  test("routes prices help/refresh/lookup and rejects a missing model id", () => {
    assert.deepEqual(route(["prices"]), { kind: "prices-help" });
    assert.deepEqual(route(["prices", "refresh"]), { kind: "prices-refresh", scope: "all" });
    assert.deepEqual(route(["prices", "refresh", "cursor"]), {
      kind: "prices-refresh",
      scope: "cursor",
    });
    assert.deepEqual(route(["prices", "lookup", "gpt-5"]), {
      kind: "prices-lookup",
      modelId: "gpt-5",
      provider: "",
    });
    assert.deepEqual(route(["prices", "lookup", "gpt-5", "cursor"]), {
      kind: "prices-lookup",
      modelId: "gpt-5",
      provider: "cursor",
    });
    assert.throws(() => route(["prices", "lookup"]), UsageError);
  });

  test("routes obs, lessons, and init to their tool entries with remaining args forwarded", () => {
    assert.deepEqual(route(["obs", "live"]), { kind: "entry", entry: "obs-cli", args: ["live"] });
    assert.deepEqual(route(["lessons", "list"]), {
      kind: "entry",
      entry: "lessons-cli",
      args: ["list"],
    });
    assert.deepEqual(route(["init", "--minimal"]), {
      kind: "entry",
      entry: "init-project",
      args: ["--minimal"],
    });
  });

  test("help with no topic returns the built-in help; with a topic routes to help-topic", () => {
    assert.deepEqual(route(["help"]), { kind: "help" });
    assert.deepEqual(route(["help", "prices"]), {
      kind: "entry",
      entry: "help-topic",
      args: ["prices"],
    });
  });

  test("an unrecognized subcommand routes to 'unknown'", () => {
    assert.deepEqual(route(["nonsense"]), { kind: "unknown", cmd: "nonsense" });
  });
});

describe("harness test — step plan and runner", () => {
  test("buildTestSteps runs build check, boundaries, docs-bundle, and every __test__ suite in order", () => {
    const steps = buildTestSteps();
    assert.deepEqual(
      steps.map((s) => s.label),
      [
        "biome check",
        "tsc --noEmit",
        "src suite",
        "tools suite",
        "knip: dead files and dependencies",
        "knip: unused exports do not grow",
        "check-boundaries",
        "check-suppressions",
        "check-wiring",
        "check-docs-bundle",
        "check-decisions",
        "check-screens",
        "check-obs-contract",
        "check-manifest",
        "capabilities in sync",
        "changelog in sync",
        "log in sync",
        "coverage in sync",
      ],
    );
    /**
     * hazard: three fixable warnings sat in this repo across several green gates, because a warn-level rule does not
     * change biome's exit code. The flag is asserted rather than trusted
     * ([/decisions/ad-051.md](/decisions/ad-051.md)).
     */
    assert.deepEqual(steps[0]?.args, ["biome", "check", "--error-on-warnings"]);
    // why: both suites carry the hermetic setup module. Without it the runner reads CLAUDE_PROJECT_DIR from
    // whatever launched it and 22 tests resolve against the real repository instead of their own fixtures.
    assert.deepEqual(steps[2]?.args, [
      "--import",
      "./tools/test-env.mjs",
      "--test",
      "src/**/__test__/*.test.ts",
    ]);
    assert.deepEqual(steps[3]?.args, [
      "--import",
      "./tools/test-env.mjs",
      "--test",
      "tools/__test__/*.test.ts",
    ]);
    /**
     * hazard: these were asserted by position, so inserting a step rewrote a dozen unrelated lines and the diff said
     * nothing about what changed. Looked up by label, each assertion states the one fact it owns — this step runs
     * that script ([/decisions/ad-102.md](/decisions/ad-102.md)).
     */
    const argsOf = (label: string): string[] | undefined => steps.find((step) => step.label === label)?.args;

    for (const [label, args] of [
      ["check-boundaries", ["tools/dev/check-boundaries.ts"]],
      ["check-suppressions", ["tools/dev/check-suppressions.ts"]],
      ["check-wiring", ["tools/dev/check-wiring.ts"]],
      ["check-docs-bundle", ["tools/dev/check-docs-bundle.ts"]],
      ["check-screens", ["tools/dev/check-screens.ts"]],
      ["check-obs-contract", ["tools/dev/check-obs-contract.ts"]],
      ["check-manifest", ["tools/dev/check-manifest.ts"]],
      ["capabilities in sync", ["tools/dev/render-capabilities.ts", "--check"]],
      ["changelog in sync", ["tools/dev/render-changelog.ts", "--check"]],
    ] as const) {
      assert.deepEqual(argsOf(label), [...args], label);
    }

    // why the ceiling is asserted and not just the flag: a step that reports without failing is a signal that never
    // fires, and the number is what makes this one fire on growth.
    assert.deepEqual(argsOf("knip: dead files and dependencies"), ["knip", "--files", "--dependencies"]);
    assert.deepEqual(argsOf("knip: unused exports do not grow"), [
      "knip",
      "--exports",
      "--max-issues",
      String(KNIP_EXPORTS_CEILING),
    ]);

    /**
     * hazard: the assertion above compares the argument with the constant it came from, so raising the ceiling from
     * 76 to 500 left every test green — the debt could be switched off with no red anywhere. Found by an independent
     * review ([/decisions/ad-102.md](/decisions/ad-102.md)).
     *
     * invariant: a literal, and an inequality. Lowering the ceiling is free, which is the point; raising it fails
     * here, so it has to be argued for in a diff somebody reads.
     */
    assert.ok(
      KNIP_EXPORTS_CEILING <= 76,
      `the unused-export ceiling went up to ${KNIP_EXPORTS_CEILING}. Lowering it is free; raising it is a decision.`,
    );
  });

  test("stops at the first failing step and does not run the rest", () => {
    const calls: string[] = [];
    const status = runTestSteps(buildTestSteps(), "/repo", (bin, args, cwd) => {
      calls.push(`${bin} ${args.join(" ")}`);
      assert.equal(cwd, "/repo");
      return { status: calls.length === 2 ? 1 : 0 };
    });
    assert.equal(status, 1);
    assert.deepEqual(calls, ["npx biome check --error-on-warnings", "npx tsc --noEmit"]);
  });

  test("runs every step and returns 0 when all pass", () => {
    const calls: string[] = [];
    const status = runTestSteps(buildTestSteps(), "/repo", (bin) => {
      calls.push(bin);
      return { status: 0 };
    });
    assert.equal(status, 0);
    assert.equal(calls.length, buildTestSteps().length);
  });
});

describe("status agrees with the policy the hooks resolve", () => {
  function writePolicy(root: string, patch: Record<string, unknown>): void {
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(patch), "utf8");
  }

  // hazard: status used to read flag files only and default to "solo", so a project whose policy set the
  // deepest posture reported solo with grind off while every hook resolved the opposite.
  test("a configured posture is reported, with config as the origin", () => {
    const root = newRoot();
    writePolicy(root, { version: 1, mode: "focus" });
    const report = statusJson(root);
    assert.equal(report.mode, "focus");
    assert.equal(report.modeOrigin, "config");
    assert.equal(report.modeInvalid, undefined);
  });

  // why: the two are independent now. A posture that reported grind on would be claiming a capability the
  // config left off — the same class of lie, pointed the other way.
  test("no posture reports grind on by itself", () => {
    const root = newRoot();
    writePolicy(root, { version: 1, mode: "focus" });
    assert.equal(statusJson(root).grind, false);
  });

  test("policy grind.enabled is reported without any flag file", () => {
    const root = newRoot();
    writePolicy(root, { version: 1, grind: { enabled: true } });
    const report = statusJson(root);
    assert.equal(report.grind, true);
    assert.equal(report.mode, "solo");
  });

  test("a mode file keeps precedence over the policy, and says so", () => {
    const root = newRoot();
    writePolicy(root, { version: 1, mode: "focus" });
    setMode(root, "paired");
    const report = statusJson(root);
    assert.equal(report.mode, "paired");
    assert.equal(report.modeOrigin, "file");
  });

  test("a flag keeps precedence over the policy, and says so", () => {
    const root = newRoot();
    writePolicy(root, { version: 1, mode: "solo" });
    ensureFlagsDir(root);
    writeFileSync(focusFlagPath(root), "");
    const report = statusJson(root);
    assert.equal(report.mode, "focus");
    assert.equal(report.modeOrigin, "flag");
  });

  test("an unrecognised mode file is ignored, matching the loader", () => {
    const root = newRoot();
    writePolicy(root, { version: 1, mode: "paired" });
    ensureFlagsDir(root);
    writeFileSync(modeFilePath(root), "sideways\n");
    const report = statusJson(root);
    assert.equal(report.mode, "paired");
    assert.equal(report.modeOrigin, "config");
  });

  // why: a configured value that cannot be honoured is the case the operator most needs named. Reporting the
  // replacement posture with `config` as its origin would say the operator asked for what they did not ask for.
  test("a configured value that is not a posture reports fallback and names it", () => {
    const root = newRoot();
    writePolicy(root, { version: 1, mode: "heads-down" });
    const report = statusJson(root);
    assert.equal(report.mode, "solo");
    assert.equal(report.modeOrigin, "fallback");
    assert.equal(report.modeInvalid, "heads-down");
  });

  test("the text form carries the rejected value and the accepted words", () => {
    const root = newRoot();
    writePolicy(root, { version: 1, mode: "heads-down" });
    const text = statusText(root);
    assert.match(text, /heads-down/);
    assert.match(text, /paired \| solo \| focus/);
  });

  test("the text form renders the same values as the json form", () => {
    const root = newRoot();
    writePolicy(root, { version: 1, mode: "focus", grind: { enabled: true } });
    const report = statusJson(root);
    const text = statusText(root);
    assert.ok(text.includes(report.mode));
    assert.ok(text.includes(`from ${report.modeOrigin}`));
    assert.match(text, /grind:\s+.*ON/);
  });

  test("pause still comes from the flag the stop reads", () => {
    const root = newRoot();
    writePolicy(root, { version: 1 });
    assert.equal(statusJson(root).gatesPaused, false);
    setPaused(root, true);
    assert.equal(statusJson(root).gatesPaused, true);
  });
});

describe("gate command", () => {
  function writeConfig(root: string, content: string): void {
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  function readConfig(root: string): Record<string, never> {
    return JSON.parse(readFileSync(projectConfigPath(root), "utf8"));
  }

  test("route accepts both fields and rejects anything else", () => {
    assert.deepEqual(route(["gate", "test-command", "node", "--test"]), {
      kind: "gate",
      field: "test",
      argv: ["node", "--test"],
    });
    assert.deepEqual(route(["gate", "lint-command", "npx", "biome"]), {
      kind: "gate",
      field: "lint",
      argv: ["npx", "biome"],
    });
    assert.throws(() => route(["gate"]), UsageError);
    assert.throws(() => route(["gate", "whatever"]), UsageError);
  });

  test("the argv is written as an array and reported back", () => {
    const root = newRoot();
    writeConfig(root, JSON.stringify({ version: 1 }, null, 2));
    const message = setGateCommand(root, "test", ["node", "--test", "src/**/*.test.ts"], true);

    assert.deepEqual(readConfig(root).grind, { testCommand: ["node", "--test", "src/**/*.test.ts"] });
    assert.match(message, /grind\.testCommand/);
    assert.match(message, /--test/);
  });

  test("lint-command writes the sibling field without disturbing the other", () => {
    const root = newRoot();
    writeConfig(root, JSON.stringify({ grind: { testCommand: ["node"], maxLoops: 3 } }, null, 2));
    setGateCommand(root, "lint", ["npx", "biome", "check", "."], true);

    assert.deepEqual(readConfig(root).grind, {
      testCommand: ["node"],
      maxLoops: 3,
      lintCommand: ["npx", "biome", "check", "."],
    });
  });

  // why: the write has to be reviewable as one changed field. Canonical two-space JSON is byte-for-byte what
  // these configs already are, so every untouched line stays put.
  test("every untouched field survives byte-for-byte", () => {
    const root = newRoot();
    const original = { version: 1, codePaths: ["src"], grind: { enabled: true, maxLoops: 3 } };
    writeConfig(root, `${JSON.stringify(original, null, 2)}\n`);
    setGateCommand(root, "test", ["node", "--test"], true);

    const after = readFileSync(projectConfigPath(root), "utf8");
    const expected = `${JSON.stringify(
      {
        version: 1,
        codePaths: ["src"],
        grind: { enabled: true, maxLoops: 3, testCommand: ["node", "--test"] },
      },
      null,
      2,
    )}\n`;
    assert.equal(after, expected);
  });

  test("an empty argv is a usage error and writes nothing", () => {
    const root = newRoot();
    writeConfig(root, JSON.stringify({ version: 1 }));
    assert.throws(() => setGateCommand(root, "test", [], true), UsageError);
    assert.equal(readConfig(root).grind, undefined);
  });

  // invariant: a second layer behind the floor. The floor refuses this command from inside an agent session;
  // this refuses it from anything that is not a person at a terminal.
  test("a non-interactive invocation is refused and writes nothing", () => {
    const root = newRoot();
    writeConfig(root, JSON.stringify({ version: 1 }));
    assert.throws(() => setGateCommand(root, "test", ["node", "--test"], false), UsageError);
    assert.equal(readConfig(root).grind, undefined);
  });

  test("a binary that is not on PATH is refused and writes nothing", () => {
    const root = newRoot();
    writeConfig(root, JSON.stringify({ version: 1 }));
    assert.throws(
      () => setGateCommand(root, "test", ["definitely-not-a-real-binary-xyz", "--test"], true),
      UsageError,
    );
    assert.equal(readConfig(root).grind, undefined);
  });

  test("resolveExecutable finds a name on PATH and rejects one that is absent", () => {
    assert.ok(resolveExecutable("node") !== null);
    assert.equal(resolveExecutable("definitely-not-a-real-binary-xyz"), null);
    assert.equal(resolveExecutable("also-not-real", { PATH: "" }), null);
  });

  test("writing a gate command refreshes the baseline, so the session is not blocked", () => {
    const root = newRoot();
    writeConfig(root, JSON.stringify({ version: 1 }, null, 2));
    coreFacade.policy.recordPolicyBaseline(root, "s1");
    setGateCommand(root, "test", ["node", "--test"], true);

    assert.equal(coreFacade.policy.checkPolicyBaseline(root, "s1").kind, "allow");
  });

  test("the flag mutators refresh the baseline too, and an out-of-band write does not", () => {
    const root = newRoot();
    writeConfig(root, JSON.stringify({ version: 1 }, null, 2));
    coreFacade.policy.recordPolicyBaseline(root, "s1");

    setPaused(root, true);
    assert.equal(coreFacade.policy.checkPolicyBaseline(root, "s1").kind, "allow");
    setGrind(root, true);
    assert.equal(coreFacade.policy.checkPolicyBaseline(root, "s1").kind, "allow");
    setMode(root, "solo");
    assert.equal(coreFacade.policy.checkPolicyBaseline(root, "s1").kind, "allow");

    // why: the same effect reached without a harness command stays visible, which is the whole point.
    writeFileSync(join(flagsDir(root), "skip-verify"), "", "utf8");
    rmSync(join(flagsDir(root), "skip-verify"));
    writeConfig(root, JSON.stringify({ version: 1, mode: "paired" }, null, 2));
    assert.equal(coreFacade.policy.checkPolicyBaseline(root, "s1").kind, "deny");
  });

  test("help names the new subcommand", () => {
    assert.match(helpText(), /gate test-command/);
    assert.match(helpText(), /gate lint-command/);
  });
});

describe("attest", () => {
  test("an empty chain reports OK with no sessions, and does not read as tampering", () => {
    const root = newRoot();
    const report = attestJson(root);
    assert.equal(report.ok, true);
    assert.equal(report.sessions, 0);
    assert.match(attestText(root), /no sessions recorded yet/);
  });

  // why: the artifact a reviewer reads. It has to name what the session ran under, not just that it ran.
  test("the text form names the policy fingerprint, the rails and the gates", () => {
    const root = newRoot();
    coreFacade.attest.appendAttestation(root, {
      ts: "2026-08-04T10:00:00Z",
      provider: "provider-a",
      session: "s1",
      policyFingerprint: "deadbeef",
      policyDiverged: false,
      railsActive: ["grind", "comments"],
      decisionsByRule: { comments: 2 },
      gates: { pass: 3, fail: 1 },
    });
    const text = attestText(root);
    assert.match(text, /deadbeef/);
    assert.match(text, /grind, comments/);
    assert.match(text, /3 pass \/ 1 fail/);
    assert.match(text, /comments=2/);
  });

  // why: a mid-session policy change is the one fact a reviewer most needs, and it must be impossible to miss.
  test("a diverged policy is called out in the text, not buried in a field", () => {
    const root = newRoot();
    coreFacade.attest.appendAttestation(root, {
      ts: "2026-08-04T10:00:00Z",
      provider: "provider-a",
      session: "s1",
      policyFingerprint: "abc",
      policyDiverged: true,
      railsActive: [],
      decisionsByRule: {},
      gates: { pass: 0, fail: 0 },
    });
    assert.match(attestText(root), /DIVERGED mid-session/);
  });

  test("a broken chain is reported as broken, with the index", () => {
    const root = newRoot();
    for (const session of ["s1", "s2"]) {
      coreFacade.attest.appendAttestation(root, {
        ts: `2026-08-04T10:00:0${session.slice(1)}Z`,
        provider: "provider-a",
        session,
        policyFingerprint: "abc",
        policyDiverged: false,
        railsActive: [],
        decisionsByRule: {},
        gates: { pass: 0, fail: 0 },
      });
    }
    const path = coreFacade.attest.attestationPath(root);
    const rows = readFileSync(path, "utf8").trimEnd().split("\n");
    const tampered = JSON.parse(rows[1] as string) as { gates: { pass: number; fail: number } };
    tampered.gates = { pass: 42, fail: 0 };
    rows[1] = JSON.stringify(tampered);
    writeFileSync(path, `${rows.join("\n")}\n`);

    const report = attestJson(root);
    assert.equal(report.ok, false);
    assert.equal(report.brokenAt, 1);
    assert.match(attestText(root), /BROKEN at record 1/);
  });

  test("route recognises attest", () => {
    assert.deepEqual(route(["attest"]), { kind: "attest" });
  });

  test("help names the subcommand", () => {
    assert.match(helpText(), /tlc harness attest/);
  });
});

describe("policy accept", () => {
  function diverge(root: string): string {
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1 }), "utf8");
    coreFacade.policy.recordPolicyBaseline(root, "s1");
    writeFileSync(path, JSON.stringify({ version: 2 }), "utf8");
    return path;
  }

  // invariant: lock 2 of four. A script must not be able to clear a divergence, and the refusal writes nothing.
  test("without an interactive terminal it refuses and writes nothing", () => {
    const root = newRoot();
    const path = diverge(root);
    assert.throws(() => acceptPolicy(root, [path], false), UsageError);
    assert.equal(coreFacade.policy.checkPolicyBaseline(root, "s1").kind, "deny");
  });

  // invariant: lock 3 of four. Naming the path is the confirmation — a bare accept would be a keystroke, and a
  // keystroke becomes reflex.
  test("with no path named it refuses and points at the listing", () => {
    const root = newRoot();
    diverge(root);
    assert.throws(() => acceptPolicy(root, [], true), /tlc harness policy accept --all/);
  });

  test("accepting a named diverged source clears it", () => {
    const root = newRoot();
    const path = diverge(root);
    assert.match(acceptPolicy(root, [path], true), /accepted/);
    assert.equal(coreFacade.policy.checkPolicyBaseline(root, "s1").kind, "allow");
  });

  test("a path the loader never reads is refused, naming the real sources", () => {
    const root = newRoot();
    diverge(root);
    assert.throws(() => acceptPolicy(root, [join(root, "src", "app.ts")], true), /not a policy source/);
  });

  test("the listing changes nothing and names the command", () => {
    const root = newRoot();
    const path = diverge(root);
    const text = policyText(root);
    assert.match(text, /changed out of band/);
    assert.match(text, /tlc harness policy accept/);
    assert.equal(coreFacade.policy.checkPolicyBaseline(root, "s1").kind, "deny", "listing must not clear it");
    assert.deepEqual(policyJson(root), { diverged: [path], ok: false });
  });

  test("a matching baseline reports ok without prescribing anything", () => {
    const root = newRoot();
    mkdirSync(dirname(projectConfigPath(root)), { recursive: true });
    writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1 }), "utf8");
    coreFacade.policy.recordPolicyBaseline(root, "s1");
    assert.equal(policyJson(root).ok, true);
    assert.doesNotMatch(policyText(root), /accept/);
  });

  test("route parses the listing and the accept forms, and rejects a third", () => {
    assert.deepEqual(route(["policy"]), { kind: "policy", accept: [] });
    assert.deepEqual(route(["policy", "accept", "a", "b"]), { kind: "policy", accept: ["a", "b"] });
    assert.throws(() => route(["policy", "bless"]), UsageError);
  });

  test("help names the subcommand", () => {
    assert.match(helpText(), /tlc harness policy/);
  });
});

describe("version and update --check", () => {
  // why: says so rather than printing an empty revision. A linked checkout with no `.git` is a real install shape,
  // and it is also the shape where `update` cannot pull — worth saying in the same breath.
  test("a runtime that is not a git checkout reports an unknown revision and says why", () => {
    const root = newRoot();
    assert.deepEqual(runtimeRevision(root), { revision: null, date: null });
  });

  test("the pending report on a non-git runtime is not an error", () => {
    const root = newRoot();
    const report = pendingUpdate(root, "origin/main");
    assert.equal(report.ok, false);
    assert.equal(report.commits, 0);
    assert.match(pendingText(report), /not a git checkout/);
  });

  test("a current runtime says so rather than printing an empty list", () => {
    assert.match(pendingText({ ok: true, commits: 0, decisions: [] }), /is current/);
  });

  test("a pending update reports the count and states that nothing changed yet", () => {
    const text = pendingText({
      ok: true,
      commits: 4,
      decisions: [
        { id: "AD-031", title: "AD-031 — A thing", path: "/decisions/ad-031.md", migration: "Do X." },
      ],
    });
    assert.match(text, /4 commit\(s\) would be pulled/);
    assert.match(text, /Nothing has changed yet/);
    assert.match(text, /cannot detect for you/);
    assert.match(text, /Do X\./);
  });

  test("a pending update with no decisions says that, rather than showing an empty digest", () => {
    assert.match(pendingText({ ok: true, commits: 2, decisions: [] }), /no decisions landed in that range/);
  });

  /**
   * hazard: this asserted that the failure message hands the operator `git reset --hard` at the runtime path. On a
   * contributor's machine that path is a symlink to their working repository, so the message was telling them to
   * destroy uncommitted work — and it offered "re-run the installer, which replaces the checkout", which runs
   * `git pull --ff-only`, the command that had just failed. Both are gone; ownership decides what update may write
   * ([/decisions/ad-046.md](/decisions/ad-046.md)). The replacement lives in `update-artifact.test.ts`.
   */
  test("no update message hands the operator a destructive command", () => {
    for (const message of [
      linkedRuntimeMessage("/opt/tlc", "/opt/clone"),
      unmanagedRuntimeMessage("/opt/tlc"),
      resetFailureMessage("/opt/tlc", "origin/main", "fatal: x"),
    ]) {
      assert.doesNotMatch(message, /reset --hard/);
      assert.doesNotMatch(message, /replaces the checkout/);
    }
  });

  test("route recognises version and separates update from update --check", () => {
    assert.deepEqual(route(["version"]), { kind: "version" });
    assert.deepEqual(route(["update"]), { kind: "update" });
    assert.deepEqual(route(["update", "--check"]), { kind: "update-check" });
    assert.deepEqual(route(["upgrade", "--check"]), { kind: "update-check" });
  });

  test("help names both new commands", () => {
    assert.match(helpText(), /tlc harness version/);
    assert.match(helpText(), /tlc harness update --check/);
  });
});

/**
 * hazard: acceptance is written into the baseline directory of the project the command ran in, and the success
 * line claimed "every live session". Run from another directory it printed success and cleared nothing — which
 * happened twice while unblocking a live session, because nothing in the output distinguished the two
 * ([/decisions/ad-058.md](/decisions/ad-058.md)).
 */
describe("policy accept says where it applied", () => {
  test("a project with no recorded baseline is told so, and where to run instead", () => {
    const root = mkdtempSync(join(tmpdir(), "accept-none-"));
    try {
      const out = acceptPolicy(root, [join(root, ".tlc", "harness", "config.json")], true);
      assert.match(out, /no recorded session baseline/);
      assert.match(out, /Acceptance is written per project/);
      assert.match(out, /cd <that repo>/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--all with nothing diverging says so rather than claiming an acceptance", () => {
    const root = mkdtempSync(join(tmpdir(), "accept-all-"));
    try {
      const out = acceptPolicy(root, ["--all"], true);
      assert.match(out, /nothing to accept/);
      assert.match(out, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("it still refuses without a terminal, whichever form is used", () => {
    assert.throws(() => acceptPolicy("/x", ["--all"], false), /interactive terminal/);
    assert.throws(() => acceptPolicy("/x", ["/some/path"], false), /interactive terminal/);
  });
});

/**
 * The wiring an install puts outside the runtime directory. There were three implementations of this — bash,
 * PowerShell and the POSIX branch of `update` — and the PowerShell one linked the init skill into
 * `~/.tlc/skills/harness-init`, which no provider reads. So on Windows `update` refreshed a skill nothing could
 * route to, which is the defect [/decisions/ad-095.md](/decisions/ad-095.md) fixed on the other side
 * ([/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * hazard: the provider directories are resolved from the environment, so a relocation variable inherited from the
 * shell would send these links into the operator's real directory, pointing at a scratch tree. Both are named
 * here for that reason.
 */
describe("wireRuntime", () => {
  let scratch: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "tlc-wire-"));
    for (const key of ["CURSOR_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "TLC_HOME"]) {
      saved[key] = process.env[key];
    }
    process.env.CURSOR_CONFIG_DIR = join(scratch, "cursor");
    process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  function runtime(): string {
    const dest = join(scratch, "harness");
    mkdirSync(join(dest, "skills", "harness-init"), { recursive: true });
    mkdirSync(join(dest, "bin"), { recursive: true });
    writeFileSync(join(dest, "skills", "harness-init", "SKILL.md"), "# harness-init\n");
    writeFileSync(join(dest, "config.example.json"), '{"version":1}');
    return dest;
  }

  test("AC6 the skill is linked into every provider config dir that exists, and nowhere else", () => {
    const dest = runtime();
    mkdirSync(process.env.CURSOR_CONFIG_DIR as string, { recursive: true });
    mkdirSync(process.env.CLAUDE_CONFIG_DIR as string, { recursive: true });

    const result = wireRuntime(dest, dest);

    for (const dir of [process.env.CURSOR_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR]) {
      const link = join(dir as string, "skills", "harness-init");
      assert.equal(lstatSync(link).isSymbolicLink(), true, link);
      assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), "# harness-init\n");
    }
    // invariant: never the layout the PowerShell installer wrote, which no provider reads.
    assert.equal(existsSync(join(scratch, ".tlc", "skills", "harness-init")), false);
    assert.equal(result.missingSkill, false);
  });

  test("AC6 a provider that is not installed is skipped, not created", () => {
    const dest = runtime();
    mkdirSync(process.env.CURSOR_CONFIG_DIR as string, { recursive: true });

    wireRuntime(dest, dest);

    assert.equal(existsSync(join(process.env.CURSOR_CONFIG_DIR as string, "skills", "harness-init")), true);
    assert.equal(existsSync(process.env.CLAUDE_CONFIG_DIR as string), false);
  });

  test("AC7 config.json is seeded from the example", () => {
    const dest = runtime();

    const result = wireRuntime(dest, dest);

    assert.equal(readFileSync(join(dest, "config.json"), "utf8"), '{"version":1}');
    assert.ok(result.lines.some((line) => line.includes("config seeded")));
  });

  /** invariant: relinking is what an update does every time, so it must not accumulate or fail. */
  test("wiring twice leaves one link", () => {
    const dest = runtime();
    mkdirSync(process.env.CURSOR_CONFIG_DIR as string, { recursive: true });

    wireRuntime(dest, dest);
    wireRuntime(dest, dest);

    const link = join(process.env.CURSOR_CONFIG_DIR as string, "skills", "harness-init");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  });

  test("a runtime with no skill directory is reported rather than half-wired", () => {
    const dest = join(scratch, "empty");
    mkdirSync(dest, { recursive: true });

    assert.equal(wireRuntime(dest, dest).missingSkill, true);
  });
});

/**
 * hazard: `update` on an npm install bumped the package and then materialised nothing. It spawned
 * `install-runtime` through the runtime home's own launcher, so the tool's source and destination resolved to the
 * same directory — "already at … — nothing to copy". Measured on a scratch machine: the package went 0.3.0 →
 * 0.3.2 and the runtime the hooks execute stayed on 0.3.0, while `doctor` claimed update "re-materialises this
 * directory" ([/decisions/ad-098.md](/decisions/ad-098.md)).
 */
describe("the npm update materialises the package it just installed", () => {
  /**
   * hazard: the first version named the destination too, as `runtimeHome()`. On a clean machine that resolves to
   * the package itself — the trap `installDest` exists for — so install wrote its config and its price catalogue
   * into `node_modules`, copied nothing, and crashed writing hooks
   * ([/decisions/ad-098.md](/decisions/ad-098.md)).
   */
  test("AC the plan names the source and leaves the destination to installDest", () => {
    const plan = npmSyncPlan("/npm/lib/node_modules/@tech-leads-club/harness-toolkit");

    assert.equal(plan.env.TLC_ORIGIN, "/npm/lib/node_modules/@tech-leads-club/harness-toolkit");
    assert.equal(plan.env.TLC_INSTALL_DEST, undefined, "naming the destination is how this broke");
  });

  /** invariant: the package's own launcher runs it, or a release that fixes `install` cannot deliver that fix. */
  test("AC the package's launcher runs the materialisation, not the runtime home's", () => {
    const plan = npmSyncPlan("/npm/pkg");

    assert.equal(plan.command, process.execPath);
    assert.deepEqual(plan.args, [join("/npm/pkg", "bin", "tlc-exec.mjs"), "install-runtime"]);
  });

  test("AC the package root is asked of npm and checked on disk", () => {
    const found = globalPackageRoot({ npmRoot: () => "/npm/lib/node_modules\n", exists: () => true });
    assert.equal(found, join("/npm/lib/node_modules", "@tech-leads-club", "harness-toolkit"));

    assert.equal(globalPackageRoot({ npmRoot: () => "/npm/lib/node_modules", exists: () => false }), null);
    assert.equal(globalPackageRoot({ npmRoot: () => "", exists: () => true }), null);
  });

  /** invariant: when the root cannot be found, nothing is half-written and the message says so. */
  test("AC the refusal says the runtime is untouched and names the manual route", () => {
    const message = npmRootFailureMessage("/home/me/.tlc/harness");

    assert.match(message, /unchanged — nothing was half-written/);
    assert.match(message, /npm root -g/);
    assert.match(message, /tlc harness install/);
  });
});

/**
 * hazard: `install` went through `runEntry`, so the runtime home's launcher ran the runtime home's own
 * `install-runtime` — source and destination resolved to the same directory and the code never moved. Measured:
 * package at 0.3.3, runtime left on 0.3.1, command reporting success. It is the recovery route the README and
 * every failure message name ([/decisions/ad-098.md](/decisions/ad-098.md)).
 */
describe("install runs from the package, not from the runtime it replaces", () => {
  test("AC install is its own action rather than a generic entry", () => {
    const action = route(["install"]);

    assert.equal(action.kind, "install");
    assert.deepEqual(action.kind === "install" ? action.args : ["wrong"], []);
  });

  test("AC --link reaches the tool, and keeps install local", () => {
    const action = route(["install", "--link"]);

    assert.equal(action.kind, "install");
    assert.deepEqual(action.kind === "install" ? action.args : [], ["--link"]);
  });
});

/**
 * hazard: the tool parsed `[provider]` and this route dropped it, so every lookup ran with an empty provider —
 * the one input that matches no provider plane. `prices lookup composer-2.5 cursor` answered `source: missing`
 * for a model priced `$0.5/$2.5`, while calling the tool directly resolved it. The help and `docs/measure.md`
 * documented the argument the whole time ([/decisions/ad-098.md](/decisions/ad-098.md)).
 */
describe("prices lookup carries the provider", () => {
  test("AC the provider is routed when given", () => {
    const action = route(["prices", "lookup", "composer-2.5", "cursor"]);

    assert.equal(action.kind, "prices-lookup");
    assert.equal(action.kind === "prices-lookup" ? action.provider : "?", "cursor");
    assert.equal(action.kind === "prices-lookup" ? action.modelId : "?", "composer-2.5");
  });

  /** invariant: absent means the vendor plane, not a broken lookup. */
  test("AC no provider is an empty provider, and still routes", () => {
    const action = route(["prices", "lookup", "claude-sonnet-4-5"]);

    assert.equal(action.kind === "prices-lookup" ? action.provider : "?", "");
  });

  test("AC the usage names the optional provider", () => {
    assert.throws(() => route(["prices", "lookup"]), /<model-id> \[provider\]/);
  });
});

/**
 * AC — the env still wins, because the hooks set it from the host's own payload, which knows the workspace better
 * than a directory walk can ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
test("resolveProjectRoot prefers an explicit project dir over discovery", () => {
  const previous = process.env.TLC_PROJECT_DIR;
  process.env.TLC_PROJECT_DIR = "/declared/by/the/host";
  try {
    assert.equal(resolveProjectRoot(), "/declared/by/the/host");
  } finally {
    if (previous === undefined) {
      delete process.env.TLC_PROJECT_DIR;
    } else {
      process.env.TLC_PROJECT_DIR = previous;
    }
  }
});

/** and without it, a subdirectory of a project resolves to the project — the defect this replaced. */
test("resolveProjectRoot discovers the project from a subdirectory", () => {
  const previous = process.env.TLC_PROJECT_DIR;
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "tlc-discover-"));
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  delete process.env.TLC_PROJECT_DIR;
  try {
    process.chdir(join(root, "src", "deep"));

    assert.equal(resolveProjectRoot(), realpathSync(root));
  } finally {
    process.chdir(cwd);
    if (previous !== undefined) {
      process.env.TLC_PROJECT_DIR = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
