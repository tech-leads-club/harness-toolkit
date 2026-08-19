import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installer = join(repoRoot, "install.sh");

// why: AD-006 keeps the installers out of Windows CI — install.sh needs a POSIX shell and symlinks.
const describeIfPosix = process.platform === "win32" ? describe.skip : describe;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sandbox(): { env: Record<string, string>; root: string } {
  const root = mkdtempSync(join(tmpdir(), "tlc-install-"));
  roots.push(root);
  mkdirSync(join(root, "cursor"), { recursive: true });
  mkdirSync(join(root, "claude"), { recursive: true });
  return {
    root,
    env: {
      ...process.env,
      TLC_HOME: join(root, "harness"),
      TLC_BIN_DIR: join(root, "bin"),
      // why: an unreachable repository is the probe. If the installer reaches `git clone`, it fails here and
      // nowhere else — which is exactly how each test tells the two branches apart without a network.
      TLC_REPO_URL: join(root, "no-such-repo"),
      // hazard: these four tests are about the clone/link branch, and they only stayed on it because the package
      // did not exist yet. The day it was published the installer took the npm branch instead and ran
      // `npm i -g` against the real global prefix — a test that changes the machine it runs on
      // ([/decisions/ad-082.md](/decisions/ad-082.md)).
      TLC_INSTALL_FROM_NPM: "never",
      // invariant: a belt on top of the switch. If a later edit drops `never`, an install lands in the sandbox
      // rather than in whoever is running the suite.
      npm_config_prefix: join(root, "npm-prefix"),
      CURSOR_CONFIG_DIR: join(root, "cursor"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
    } as Record<string, string>,
  };
}

function runPiped(env: Record<string, string>) {
  const source = readFileSync(installer, "utf8");
  return spawnSync("bash", [], { input: source, env, encoding: "utf8" });
}

function runFromCheckout(env: Record<string, string>) {
  return spawnSync("bash", [installer], { cwd: repoRoot, env, encoding: "utf8" });
}

describeIfPosix("install.sh", () => {
  // hazard: this is the command the README puts first. Piped through bash the script has no file on disk, so
  // BASH_SOURCE is an empty array and `set -u` aborted on line 35 with "unbound variable" followed by
  // "cd: null directory". The documented install path was broken on every platform, and nothing tested it.
  test("survives being piped, which is the documented install command", () => {
    const { env } = sandbox();
    const result = runPiped(env);
    const output = `${result.stdout}${result.stderr}`;

    assert.doesNotMatch(output, /unbound variable/, output);
    assert.doesNotMatch(output, /null directory/, output);
    // reaching the clone proves the script-root resolution completed rather than aborting before it
    assert.match(output, /does not exist|not a git repository|repository/i, output);
  });

  test("piped, it takes the clone branch rather than linking a checkout it cannot see", () => {
    const { env, root } = sandbox();
    const result = runPiped(env);
    const output = `${result.stdout}${result.stderr}`;

    assert.doesNotMatch(output, /install: linking/, output);
    assert.ok(!output.includes(repoRoot), `piped run must not resolve the checkout: ${output}`);
    assert.ok(root.length > 0);
  });

  // why: the guard must not cost the checkout path its symlink branch. An unreachable TLC_REPO_URL proves the
  // branch: if this ever fell through to `git clone`, the run would fail instead of reporting a link.
  test("run from a checkout, it links instead of cloning", () => {
    const { env } = sandbox();
    const result = runFromCheckout(env);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.match(output, /install: linking/, output);
    assert.ok(output.includes(repoRoot), output);
    assert.doesNotMatch(output, /does not exist/, output);
  });

  test("the installer never reads BASH_SOURCE without a default", () => {
    // invariant: `set -u` is on, so every BASH_SOURCE read needs a `:-` default. A future edit that drops it
    // reintroduces the exact break, and it would only show up when piped.
    const source = readFileSync(installer, "utf8");
    const unguarded = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .filter((line) => line.includes("BASH_SOURCE") && !line.includes("BASH_SOURCE[0]:-"));

    assert.deepEqual(unguarded, []);
  });
});
