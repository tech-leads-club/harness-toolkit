import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bootDir,
  conventionalRuntimeHome,
  findProjectRoot,
  flagsDir,
  loopsDir,
  machineConfigPath,
  machineHome,
  presenceDir,
  projectConfigPath,
  projectStateDir,
  runtimeHome,
} from "../paths.ts";

describe("runtimeHome", () => {
  const original = process.env.TLC_HOME;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TLC_HOME;
    } else {
      process.env.TLC_HOME = original;
    }
  });

  test("resolves under os.homedir()/.tlc/harness by default", () => {
    delete process.env.TLC_HOME;
    assert.equal(runtimeHome(), join(homedir(), ".tlc", "harness"));
  });

  test("honors TLC_HOME override", () => {
    process.env.TLC_HOME = "/custom/tlc-home";
    assert.equal(runtimeHome(), "/custom/tlc-home");
  });

  test("contains no .cursor string", () => {
    delete process.env.TLC_HOME;
    assert.equal(runtimeHome().includes(".cursor"), false);
  });
});

describe("project paths", () => {
  test("projectConfigPath resolves to <root>/.tlc/harness/config.json", () => {
    assert.equal(projectConfigPath("/repo"), join("/repo", ".tlc", "harness", "config.json"));
  });

  test("projectStateDir resolves to <root>/.tlc/harness/state", () => {
    assert.equal(projectStateDir("/repo"), join("/repo", ".tlc", "harness", "state"));
  });

  test("flagsDir, presenceDir, loopsDir, bootDir nest under the project state dir", () => {
    const state = projectStateDir("/repo");
    assert.equal(flagsDir("/repo"), join(state, "flags"));
    assert.equal(presenceDir("/repo"), join(state, "presence"));
    assert.equal(loopsDir("/repo"), join(state, "loops"));
    assert.equal(bootDir("/repo"), join(state, "boot"));
  });

  test("TLC_HOME override does not affect project paths", () => {
    const original = process.env.TLC_HOME;
    process.env.TLC_HOME = "/custom/tlc-home";
    try {
      assert.equal(projectConfigPath("/repo"), join("/repo", ".tlc", "harness", "config.json"));
    } finally {
      if (original === undefined) {
        delete process.env.TLC_HOME;
      } else {
        process.env.TLC_HOME = original;
      }
    }
  });

  test("no .cursor string in any project path", () => {
    assert.equal(projectConfigPath("/repo").includes(".cursor"), false);
    assert.equal(projectStateDir("/repo").includes(".cursor"), false);
  });
});

test("source file contains zero occurrences of process.env.HOME", () => {
  const source = readFileSync(fileURLToPath(new URL("../paths.ts", import.meta.url)), "utf8");
  assert.equal(/process\.env\.HOME\b/.test(source), false);
});

/**
 * The machine tier — user-tier config, the global lesson tier, global rules, prices, the cross-repo spool — used to
 * resolve through `runtimeHome()`, which names where the *code* lives and moves with the install. Two installs on
 * one machine meant two "global" tiers, and switching between them read as data loss
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
describe("machineHome", () => {
  test("the launcher's own resolution never invents a second machine", () => {
    const derived = { TLC_HOME: "/somewhere/a-checkout", TLC_HOME_FROM_ENV: "0" };

    assert.equal(machineHome(derived), conventionalRuntimeHome());
    assert.equal(runtimeHome(derived), "/somewhere/a-checkout", "the code still comes from the checkout");
  });

  test("an operator who chose a home gets it", () => {
    const chosen = { TLC_HOME: "/somewhere/chosen", TLC_HOME_FROM_ENV: "1" };

    assert.equal(machineHome(chosen), "/somewhere/chosen");
  });

  /** invariant: the suite pins `TLC_HOME` without the marker, and must keep its own home rather than the real one. */
  test("TLC_HOME with no marker is honoured, so a test stays hermetic", () => {
    assert.equal(machineHome({ TLC_HOME: "/tmp/hermetic" }), "/tmp/hermetic");
  });

  test("nothing set at all is the conventional home", () => {
    assert.equal(machineHome({}), conventionalRuntimeHome());
  });

  /** AC — the user-tier config is a machine path, so it follows the same rule. */
  test("the machine config path follows the machine, not the install", () => {
    assert.equal(
      machineConfigPath({ TLC_HOME: "/somewhere/a-checkout", TLC_HOME_FROM_ENV: "0" }),
      join(conventionalRuntimeHome(), "config.json"),
    );
  });
});

/**
 * hazard: `resolveProjectRoot` was `TLC_PROJECT_DIR ?? process.cwd()`, so a command run from a subdirectory took
 * the subdirectory as the project — found no config there, fell back to the machine tier, and printed a posture the
 * project had not set. Measured: `tlc harness status` from `src/` reported `solo` in a project pinned to `focus`,
 * and `policy accept` listed none of the repository's own paths. Every tool an operator already knows walks up
 * instead: `git` for `.git`, npm and cargo for their manifests ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
describe("findProjectRoot", () => {
  const project = join("/repo");
  const harness = join(project, ".tlc", "harness");
  const has = (path: string): boolean => path === harness;

  test("a command run in the project root finds it", () => {
    assert.equal(findProjectRoot(project, has), project);
  });

  test("a command run deep inside it finds the same root", () => {
    assert.equal(findProjectRoot(join(project, "src", "core", "rules"), has), project);
  });

  /** invariant: null rather than an ancestor's project, so a first `init` lands where the operator is standing. */
  test("nothing above is a project, so nothing is claimed", () => {
    assert.equal(findProjectRoot("/somewhere/else", has), null);
  });

  test("the walk stops at the filesystem root instead of looping", () => {
    assert.equal(
      findProjectRoot("/", () => false),
      null,
    );
  });

  /** why the nearest wins: a project inside a project is the operator's business, and the nearer one is theirs. */
  test("the nearest project wins over an outer one", () => {
    const inner = join(project, "packages", "app");
    const both = (path: string): boolean => path === harness || path === join(inner, ".tlc", "harness");

    assert.equal(findProjectRoot(join(inner, "src"), both), inner);
  });
});
