import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { flagsDir, projectConfigPath, projectStateDir } from "../../../platform/paths.ts";
import { DEFAULTS } from "../policy.defaults.ts";
import {
  isUnderCodePaths,
  loadPolicy,
  resolveProjectPosture,
  resolveProjectSyncMode,
} from "../policy.loader.ts";
import { forProvider } from "../policy.types.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-policy-"));
}

function withTlcHome<T>(homeDir: string, fn: () => T): T {
  const previous = process.env.TLC_HOME;
  process.env.TLC_HOME = homeDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TLC_HOME;
    } else {
      process.env.TLC_HOME = previous;
    }
  }
}

function writeProjectConfig(root: string, patch: Record<string, unknown>): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(patch));
}

function writeFlag(root: string, name: string): void {
  const dir = flagsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "");
}

function writeModeFile(root: string, content: string): void {
  const dir = projectStateDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "harness-mode"), content);
}

test("loadPolicy with no files returns the default policy", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      const policy = loadPolicy(root);
      assert.equal(policy.mode, "solo");
      assert.equal(policy.subagents.minEffort, null);
      assert.deepEqual(policy.grind, DEFAULTS.grind);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("project config overrides a field while preserving unrelated nested defaults", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeProjectConfig(root, { shipGate: { enabled: true } });
      const policy = loadPolicy(root);
      assert.equal(policy.shipGate.enabled, true);
      assert.equal(policy.shipGate.claimWindowMinutes, DEFAULTS.shipGate.claimWindowMinutes);
      assert.deepEqual(policy.grind, DEFAULTS.grind);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("project config wins over user config on conflicting fields", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "config.json"), JSON.stringify({ codePaths: ["from-user"] }));
      writeProjectConfig(root, { codePaths: ["from-project"] });
      const policy = loadPolicy(root);
      assert.deepEqual(policy.codePaths, ["from-project"]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a field absent from project config still inherits from user config", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "config.json"), JSON.stringify({ codePaths: ["from-user"] }));
      writeProjectConfig(root, { shipGate: { enabled: true } });
      const policy = loadPolicy(root);
      assert.deepEqual(policy.codePaths, ["from-user"]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("allowedModels as a bare array applies to every provider", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeProjectConfig(root, { subagents: { allowedModels: ["model-x"] } });
      const policy = loadPolicy(root);
      assert.deepEqual(forProvider(policy.subagents.allowedModels, "provider-a"), ["model-x"]);
      assert.deepEqual(forProvider(policy.subagents.allowedModels, "provider-b"), ["model-x"]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("allowedModels as a provider-keyed object leaves an absent provider unrestricted", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeProjectConfig(root, { subagents: { allowedModels: { "provider-a": ["model-x"] } } });
      const policy = loadPolicy(root);
      assert.deepEqual(forProvider(policy.subagents.allowedModels, "provider-a"), ["model-x"]);
      assert.equal(forProvider(policy.subagents.allowedModels, "provider-b"), null);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("minEffort defaults to null", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      assert.equal(loadPolicy(root).subagents.minEffort, null);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("minEffort is overridable via project config", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeProjectConfig(root, { subagents: { minEffort: "high" } });
      assert.equal(loadPolicy(root).subagents.minEffort, "high");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a valid harness-mode state file overrides the configured mode", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeModeFile(root, "paired\n");
      assert.equal(loadPolicy(root).mode, "paired");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("an invalid harness-mode state file is ignored", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeModeFile(root, "not-a-mode");
      assert.equal(loadPolicy(root).mode, "solo");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the focus flag sets mode to focus", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeFlag(root, "focus");
      assert.equal(loadPolicy(root).mode, "focus");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the paired flag sets mode to paired when focus is absent", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeFlag(root, "paired");
      assert.equal(loadPolicy(root).mode, "paired");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the focus flag takes priority over the paired flag", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeFlag(root, "focus");
      writeFlag(root, "paired");
      assert.equal(loadPolicy(root).mode, "focus");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the grind-on flag forces grind.enabled", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeFlag(root, "grind-on");
      assert.equal(loadPolicy(root).grind.enabled, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// invariant: verification does not move when posture moves. The deepest posture used to force grind on, so a
// surfacing preference silently overrode a capability that has its own switch and its own documented trade-off.
// This asserts the inverse of what the old test asserted, because the contract changed by decision.
test("no posture raises grind.enabled on its own", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      for (const posture of ["focus", "paired"] as const) {
        writeFlag(root, posture);
        const policy = loadPolicy(root);
        assert.equal(policy.mode, posture);
        assert.equal(policy.grind.enabled, false, `${posture} raised grind on its own`);
        rmSync(join(flagsDir(root), posture));
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the grind-on flag is what raises grind, at every posture", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeFlag(root, "focus");
      writeFlag(root, "grind-on");
      assert.equal(loadPolicy(root).grind.enabled, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("two loads with different project overrides do not leak state into each other", () => {
  const rootA = tempRoot();
  const rootB = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      writeProjectConfig(rootA, { subagents: { allowedModels: ["model-a"] } });
      writeProjectConfig(rootB, { subagents: { allowedModels: ["model-b"] } });
      const policyA = loadPolicy(rootA);
      const policyB = loadPolicy(rootB);
      assert.deepEqual(policyA.subagents.allowedModels, ["model-a"]);
      assert.deepEqual(policyB.subagents.allowedModels, ["model-b"]);
      assert.deepEqual(DEFAULTS.subagents.allowedModels, []);
    });
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// invariant: the posture the hooks obey and the posture `status` and `doctor` report are one answer. They used to
// be two derivations of the same fact, which is the only reason they could disagree ([/decisions/ad-020.md](/decisions/ad-020.md)).
test("the policy's mode and the reported resolution never disagree, whichever config supplies it", () => {
  const root = tempRoot();
  const home = tempRoot();
  try {
    withTlcHome(home, () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "config.json"), JSON.stringify({ mode: "paired" }));
      // why: the project config differing from the user config is what makes the precedence observable. With
      // both saying the same thing, a reversed precedence would pass.
      writeProjectConfig(root, { mode: "focus" });

      assert.equal(loadPolicy(root).mode, "focus");
      assert.deepEqual(resolveProjectPosture(root), { mode: "focus", origin: "config" });

      writeProjectConfig(root, {});
      assert.equal(loadPolicy(root).mode, "paired");
      assert.equal(resolveProjectPosture(root).mode, "paired");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * hazard: the migration line named `.tlc/harness/config.json` unconditionally, and the value can come from the
 * runtime home — so a demo run sent the reader to edit a file that did not contain it
 * ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
test("the coerced sync mode names the file the old boolean is actually in", () => {
  const root = tempRoot();
  const home = mkdtempSync(join(tmpdir(), "tlc-home-"));
  try {
    withTlcHome(home, () => {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ intelligence: { lessons: { syncRulesFile: true } } }),
      );
      const fromHome = resolveProjectSyncMode(root);
      assert.equal(fromHome.mode, "always");
      assert.equal(fromHome.coercedIn, join(home, "config.json"));

      writeProjectConfig(root, { intelligence: { lessons: { syncRulesFile: false } } });
      const fromProject = resolveProjectSyncMode(root);
      assert.equal(fromProject.mode, "never");
      assert.equal(fromProject.coercedIn, projectConfigPath(root));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// invariant: no origin to report when nothing was coerced, so the line stays absent rather than naming a file.
test("a config already carrying a mode reports no coerced origin", () => {
  const root = tempRoot();
  try {
    writeProjectConfig(root, { intelligence: { lessons: { syncRulesFile: "auto" } } });
    assert.deepEqual(resolveProjectSyncMode(root), { mode: "auto" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isUnderCodePaths matches an exact segment and a nested path, normalizing separators", () => {
  assert.equal(isUnderCodePaths("src", ["src", "apps"]), true);
  assert.equal(isUnderCodePaths("src/core/foo.ts", ["src", "apps"]), true);
  assert.equal(isUnderCodePaths("src\\core\\foo.ts", ["src", "apps"]), true);
  assert.equal(isUnderCodePaths("docs/readme.md", ["src", "apps"]), false);
});

/**
 * AC1 — a machine that never opted in must behave exactly as before, so the default is off and the shipped
 * example config must not switch it on ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
test("operator rules are off by default and stay off through an unrelated config", () => {
  assert.equal(DEFAULTS.rules.enabled, false);

  const root = tempRoot();
  writeProjectConfig(root, { version: 1, mode: "solo" });

  assert.equal(
    withTlcHome(root, () => loadPolicy(root).rules.enabled),
    false,
  );
  rmSync(root, { recursive: true, force: true });
});

test("an operator who declares the capability gets it, and nothing else changes", () => {
  const root = tempRoot();
  writeProjectConfig(root, { version: 1, rules: { enabled: true } });

  const policy = withTlcHome(root, () => loadPolicy(root));

  assert.equal(policy.rules.enabled, true);
  assert.equal(policy.mode, DEFAULTS.mode);
  rmSync(root, { recursive: true, force: true });
});

test("the shipped example config does not switch operator rules on", () => {
  const example = JSON.parse(readFileSync("config.example.json", "utf8")) as {
    rules?: { enabled?: boolean };
  };

  assert.notEqual(example.rules?.enabled, true);
});
