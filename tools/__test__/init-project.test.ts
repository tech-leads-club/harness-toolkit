import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  applyPlan,
  buildPlan,
  claudeShimEntries,
  cursorShimEntries,
  detectProviders,
  GITIGNORE_STATE,
  gitignoreEntries,
  launcherPath,
  main,
  mergeGitignore,
  PROJECT_SHIMS,
  parseFlags,
  resolvePolicy,
  UsageError,
  usageText,
} from "../init-project.ts";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "init-project-"));
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

describe("parseFlags", () => {
  test("recognizes dryRun, write, minimal, stdinJson, force", () => {
    assert.deepEqual(parseFlags(["--dry-run"]), {
      dryRun: true,
      write: false,
      minimal: false,
      stdinJson: false,
      force: false,
    });
    assert.deepEqual(parseFlags(["--minimal"]), {
      dryRun: false,
      write: true,
      minimal: true,
      stdinJson: false,
      force: false,
    });
    assert.deepEqual(parseFlags(["--write", "--stdin-json", "--force"]), {
      dryRun: false,
      write: true,
      minimal: false,
      stdinJson: true,
      force: true,
    });
  });

  test("no flags yields all-false", () => {
    assert.deepEqual(parseFlags([]), {
      dryRun: false,
      write: false,
      minimal: false,
      stdinJson: false,
      force: false,
    });
  });
});

describe("usageText", () => {
  test("names tlc harness init, never bare harness", () => {
    const text = usageText();
    assert.ok(text.includes("tlc harness init"));
    const withoutSkillName = text.replaceAll("harness-init", "");
    assert.equal(withoutSkillName.match(/(?<!tlc )\bharness\b/), null);
  });
});

describe("launcherPath", () => {
  test("resolves under bin/tlc-exec.mjs of the given runtime home", () => {
    assert.equal(launcherPath("/opt/tlc-home"), join("/opt/tlc-home", "bin", "tlc-exec.mjs"));
  });
});

describe("resolvePolicy", () => {
  test("returns DEFAULTS when minimal is set, ignoring an existing config", () => {
    const root = newRoot();
    mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
    writeFileSync(join(root, ".tlc", "harness", "config.json"), JSON.stringify({ mode: "paired" }));
    const policy = resolvePolicy(root, parseFlags(["--minimal"]), null) as { mode: string };
    assert.equal(policy.mode, "solo");
  });

  test("reuses an existing project config when present and not minimal/stdin", () => {
    const root = newRoot();
    mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
    writeFileSync(join(root, ".tlc", "harness", "config.json"), JSON.stringify({ mode: "paired" }));
    const policy = resolvePolicy(root, parseFlags(["--write"]), null) as { mode: string };
    assert.equal(policy.mode, "paired");
  });

  test("falls back to DEFAULTS when no existing config and not stdin", () => {
    const root = newRoot();
    const policy = resolvePolicy(root, parseFlags(["--write"]), null) as { version: number };
    assert.equal(policy.version, 1);
  });

  test("parses stdin JSON when --stdin-json is set", () => {
    const root = newRoot();
    const policy = resolvePolicy(root, parseFlags(["--write", "--stdin-json"]), '{"mode":"paired"}') as {
      mode: string;
    };
    assert.equal(policy.mode, "paired");
  });

  test("throws on empty stdin with --stdin-json", () => {
    const root = newRoot();
    assert.throws(() => resolvePolicy(root, parseFlags(["--write", "--stdin-json"]), ""));
  });
});

describe("mergeGitignore", () => {
  test("adds the state ignore line to an empty project", () => {
    const root = newRoot();
    const result = mergeGitignore(root);
    assert.equal(result.changed, true);
    assert.ok(result.text.includes(GITIGNORE_STATE));
  });

  /**
   * hazard: `init` writes `.cursor/hooks.json` and `.claude/settings.json` containing an absolute path to the
   * runtime on the machine that ran it, and used to ignore neither. A user committed a `settings.json` naming
   * their own home directory, and the next developer's hook pointed at a path that does not exist. This
   * repository has ignored both by hand since 2026-07-30 and never shipped that protection.
   */
  test("AC1 the shims init writes are ignored, not just the state directory", () => {
    const root = newRoot();

    const result = mergeGitignore(root);

    for (const shim of PROJECT_SHIMS) {
      assert.ok(result.text.includes(shim.split(sep).join("/")), `${shim} must be ignored`);
    }
  });

  /** invariant: what is ignored is derived from what is written, so the two lists cannot drift apart. */
  test("AC1 every entry comes from what init writes", () => {
    assert.deepEqual(gitignoreEntries(), [
      GITIGNORE_STATE,
      ...PROJECT_SHIMS.map((path) => path.split(sep).join("/")),
    ]);
  });

  /** why: posix separators. A `.gitignore` is read by git, not by the platform that generated it. */
  test("AC1 entries use forward slashes on every platform", () => {
    for (const entry of gitignoreEntries()) {
      assert.doesNotMatch(entry, /\\/, entry);
    }
  });

  test("adds only what is missing, and is idempotent once every entry is present", () => {
    const root = newRoot();
    writeFileSync(join(root, ".gitignore"), `node_modules/\n${GITIGNORE_STATE}\n`);

    // the state line is there and the shims are not, so this run adds exactly the shims
    const first = mergeGitignore(root);
    assert.equal(first.changed, true);
    assert.equal(first.text.split("\n").filter((line) => line === GITIGNORE_STATE).length, 1);

    writeFileSync(join(root, ".gitignore"), first.text);
    const second = mergeGitignore(root);
    assert.equal(second.changed, false);
    assert.equal(second.text, first.text);
  });

  test("preserves existing unrelated lines", () => {
    const root = newRoot();
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n");
    const result = mergeGitignore(root);
    assert.ok(result.text.includes("node_modules/"));
    assert.ok(result.text.includes("dist/"));
    assert.ok(result.text.includes(GITIGNORE_STATE));
  });
});

describe("detectProviders", () => {
  test("reports true only for providers whose config dir exists", () => {
    const home = newRoot();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    assert.deepEqual(detectProviders({ cursor: join(home, ".cursor"), claude: join(home, ".claude-alt") }), {
      cursor: true,
      claude: false,
    });
  });

  test("reports false for both when neither config dir exists", () => {
    const home = newRoot();
    assert.deepEqual(detectProviders({ cursor: join(home, ".cursor"), claude: join(home, ".claude") }), {
      cursor: false,
      claude: false,
    });
  });

  test("a relocated claude config dir is what gets probed", () => {
    const home = newRoot();
    mkdirSync(join(home, ".claude-alt"), { recursive: true });
    assert.deepEqual(detectProviders({ cursor: join(home, ".cursor"), claude: join(home, ".claude-alt") }), {
      cursor: false,
      claude: true,
    });
  });
});

describe("cursorShimEntries / claudeShimEntries", () => {
  test("cursor entries dispatch through the shim entry name", () => {
    const entries = cursorShimEntries("/launcher/tlc-exec.mjs");
    const stop = entries.find((entry) => entry.hookEvent === "stop");
    // invariant: one command, on every platform ([/decisions/ad-097.md](/decisions/ad-097.md)).
    assert.equal(stop?.command, "node");
    assert.deepEqual(stop?.args?.slice(-3), ["/launcher/tlc-exec.mjs", "shim", "stop"]);
  });

  test("claude entries use exec form with a shim argv", () => {
    const entries = claudeShimEntries("/launcher/tlc-exec.mjs");
    const stop = entries.find((entry) => entry.hookEvent === "Stop");
    assert.deepEqual(stop?.args, ["/launcher/tlc-exec.mjs", "shim", "stop"]);
  });
});

describe("buildPlan (dry-run)", () => {
  test("includes a cursor document only when cursor is present", () => {
    const root = newRoot();
    const planWith = buildPlan(root, parseFlags(["--minimal"]), null, { cursor: true, claude: false });
    const planWithout = buildPlan(root, parseFlags(["--minimal"]), null, { cursor: false, claude: false });
    assert.notEqual(planWith.cursorHooksDocument, null);
    assert.equal(planWithout.cursorHooksDocument, null);
  });

  test("includes a claude preview only when claude is present", () => {
    const root = newRoot();
    const planWith = buildPlan(root, parseFlags(["--minimal"]), null, { cursor: false, claude: true });
    const planWithout = buildPlan(root, parseFlags(["--minimal"]), null, { cursor: false, claude: false });
    assert.notEqual(planWith.claudeHooksPreview, null);
    assert.equal(planWithout.claudeHooksPreview, null);
  });
});

describe("applyPlan", () => {
  test("writes .tlc/harness/config.json and the gitignore line", () => {
    const root = newRoot();
    const outcome = applyPlan(root, parseFlags(["--minimal"]), { cursor: false, claude: false }, null);
    assert.ok(existsSync(outcome.configPath));
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    assert.ok(gitignore.includes(GITIGNORE_STATE));
  });

  test("skips both providers when neither is present", () => {
    const root = newRoot();
    const outcome = applyPlan(root, parseFlags(["--minimal"]), { cursor: false, claude: false }, null);
    assert.deepEqual(outcome.cursor, { skipped: true });
    assert.deepEqual(outcome.claude, { skipped: true });
    assert.equal(existsSync(join(root, ".cursor", "hooks.json")), false);
    assert.equal(existsSync(join(root, ".claude", "settings.json")), false);
  });

  test("writes the cursor project hooks.json when cursor is present", () => {
    const root = newRoot();
    const outcome = applyPlan(root, parseFlags(["--minimal"]), { cursor: true, claude: false }, null);
    assert.equal(outcome.cursor.skipped, false);
    assert.ok(existsSync(join(root, ".cursor", "hooks.json")));
  });

  test("merges the claude project settings.json when claude is present", () => {
    const root = newRoot();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ someOtherKey: "keep-me" }));
    const outcome = applyPlan(root, parseFlags(["--minimal"]), { cursor: false, claude: true }, null);
    assert.equal(outcome.claude.skipped, false);
    const parsed = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    assert.equal(parsed.someOtherKey, "keep-me");
    assert.ok(parsed.hooks.Stop);
  });

  test("re-running is idempotent for both providers and the gitignore", () => {
    const root = newRoot();
    applyPlan(root, parseFlags(["--minimal"]), { cursor: true, claude: false }, null);
    const before = readFileSync(join(root, ".cursor", "hooks.json"), "utf8");
    const outcome = applyPlan(root, parseFlags(["--minimal"]), { cursor: true, claude: false }, null);
    assert.equal(outcome.cursor.skipped, false);
    assert.equal(outcome.cursor.status, "unchanged");
    assert.equal(readFileSync(join(root, ".cursor", "hooks.json"), "utf8"), before);
  });
});

describe("usage error", () => {
  test("main throws UsageError when neither --dry-run nor --write/--minimal is given", async () => {
    const root = newRoot();
    const originalEnv = process.env.TLC_PROJECT_DIR;
    process.env.TLC_PROJECT_DIR = root;
    try {
      await assert.rejects(() => main([]), UsageError);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.TLC_PROJECT_DIR;
      } else {
        process.env.TLC_PROJECT_DIR = originalEnv;
      }
    }
  });
});
