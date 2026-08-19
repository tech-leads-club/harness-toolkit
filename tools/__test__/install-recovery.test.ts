import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { route, UsageError } from "../../bin/tlc-cli.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cleanup: string[] = [];

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * The state every existing install is in: `dist/` rewritten by a previous build with a different bundler, so
 * `pull --ff-only` aborts. The fix for `update` lives in the revision `update` cannot reach, which is why the
 * installer has to be the recovery route ([/decisions/ad-048.md](/decisions/ad-048.md)).
 */
function stuckInstall(): { install: string; upstream: string } {
  const scratch = newDir("tlc-recovery-");
  const upstream = join(scratch, "upstream.git");
  const work = join(scratch, "work");
  git(scratch, ["init", "-q", "--bare", "upstream.git"]);
  git(scratch, ["clone", "-q", upstream, "work"]);
  git(work, ["config", "user.email", "t@e.c"]);
  git(work, ["config", "user.name", "T"]);
  writeFileSync(join(work, ".gitignore"), "/state/\nconfig.json\n");
  mkdirSync(join(work, "bin"), { recursive: true });
  mkdirSync(join(work, "dist"), { recursive: true });
  mkdirSync(join(work, "skills", "harness-init"), { recursive: true });
  writeFileSync(join(work, "bin", "tlc-exec.mjs"), "");
  writeFileSync(join(work, "bin", "tlc"), "");
  writeFileSync(join(work, "bin", "tlc-exec"), "");
  writeFileSync(join(work, "bin", "tlc-build"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(work, "install.sh"), "#!/usr/bin/env bash\n");
  // why: git tracks files, not directories, so the skill needs content or the hard reset removes the directory the
  // installer then reports as missing.
  writeFileSync(join(work, "skills", "harness-init", "SKILL.md"), "# harness-init\n");
  writeFileSync(join(work, "config.example.json"), '{"version":1}');
  writeFileSync(join(work, "dist", "stop.mjs"), "// upstream v1\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-qm", "v1"]);
  git(work, ["push", "-q", "origin", "HEAD:main"]);

  const install = join(scratch, "install");
  git(scratch, ["clone", "-q", "-b", "main", upstream, "install"]);

  writeFileSync(join(work, "dist", "stop.mjs"), "// upstream v2\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-qm", "v2"]);
  // hazard: `push origin main` needs a *local* branch called main, and a clone of an empty bare repository takes
  // its name from `init.defaultBranch` — `main` on this machine, `master` on CI. Pushing `HEAD:main` names the
  // remote ref and asks nothing of the local one.
  git(work, ["push", "-q", "origin", "HEAD:main"]);

  // the dirt: a local build rewrote the bundle with different bytes
  writeFileSync(join(install, "dist", "stop.mjs"), "// rebuilt locally by esbuild\n");
  mkdirSync(join(install, "state"), { recursive: true });
  writeFileSync(join(install, "state", "lessons.json"), '{"global":"rule"}');
  writeFileSync(join(install, "config.json"), '{"mine":true}');
  return { install, upstream };
}

/**
 * why: the script is copied to a bare directory first. Run from inside a clone, `install.sh` takes its linking
 * branch — `BASH_SOURCE` has a sibling `bin/tlc-exec.mjs` — which is correct for a contributor and not the path
 * under test. A `curl | bash` install has no such sibling, and a lone copy is the faithful model of it.
 */
function runInstaller(dest: string): { status: number | null; output: string } {
  const standalone = join(newDir("tlc-installer-"), "install.sh");
  writeFileSync(standalone, readFileSync(join(repoRoot, "install.sh"), "utf8"));
  const result = spawnSync("bash", [standalone], {
    encoding: "utf8",
    env: {
      ...process.env,
      TLC_HOME: dest,
      TLC_BIN_DIR: join(newDir("tlc-bin-"), "bin"),
      HOME: newDir("tlc-fakehome-"),
    },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * invariant: the installer recovers a stuck managed checkout. It is the only route that does not run through the
 * installed CLI, and the CLI is what was broken — a self-updating tool whose updater fails cannot deliver its own
 * fix.
 */
test("the installer moves a stuck managed checkout to upstream", () => {
  const { install } = stuckInstall();
  const result = runInstaller(install);
  assert.equal(result.status, 0, result.output);
  assert.equal(readFileSync(join(install, "dist", "stop.mjs"), "utf8").trim(), "// upstream v2");
  assert.doesNotMatch(result.output, /would be overwritten by merge/);
});

// invariant: what the operator owns survives the recovery. state/ and config.json are gitignored, so a hard reset
// cannot reach them — asserted, because the whole recovery rests on it.
test("recovery keeps the operator's state and config", () => {
  const { install } = stuckInstall();
  assert.equal(runInstaller(install).status, 0);
  assert.equal(readFileSync(join(install, "state", "lessons.json"), "utf8"), '{"global":"rule"}');
  assert.equal(readFileSync(join(install, "config.json"), "utf8"), '{"mine":true}');
});

/**
 * hazard: `[[ -d "$DEST/.git" ]]` follows a symlink, so a linked contributor clone matched the checkout branch. A
 * hard reset there destroys uncommitted work — the same danger AD-046 removed from the CLI, which would have come
 * straight back through the installer.
 */
test("the installer never runs git against a linked clone", () => {
  const scratch = newDir("tlc-linked-");
  const clone = join(scratch, "clone");
  mkdirSync(clone, { recursive: true });
  git(scratch, ["init", "-q", "clone"]);
  mkdirSync(join(clone, "bin"), { recursive: true });
  mkdirSync(join(clone, "skills", "harness-init"), { recursive: true });
  for (const name of ["tlc-exec.mjs", "tlc", "tlc-exec", "tlc-build"]) {
    writeFileSync(join(clone, "bin", name), "");
  }
  writeFileSync(join(clone, "UNCOMMITTED.txt"), "must survive\n");
  const link = join(scratch, "runtime");
  symlinkSync(clone, link, "dir");

  const result = runInstaller(link);
  assert.match(result.output, /leaving that clone untouched/);
  assert.equal(existsSync(join(clone, "UNCOMMITTED.txt")), true);
  assert.equal(readFileSync(join(clone, "UNCOMMITTED.txt"), "utf8").trim(), "must survive");
});

/**
 * hazard: `update` accepted any flag in silence. An operator whose update had failed typed `--force`, got no
 * acknowledgement that it does not exist, and read the same failure as a refusal to force.
 */
test("update --force says what to do instead of being ignored", () => {
  assert.throws(() => route(["update", "--force"]), UsageError);
  assert.throws(() => route(["update", "--force"]), /takes no --force/);
  assert.throws(() => route(["update", "--force"]), /npm i -g @tech-leads-club\/harness-toolkit@latest/);
});

test("update rejects an unknown flag by name", () => {
  assert.throws(() => route(["update", "--wat"]), /unknown flag: --wat/);
});

test("update --check still routes, and a bare update still routes", () => {
  assert.equal(route(["update", "--check"]).kind, "update-check");
  assert.equal(route(["update"]).kind, "update");
});
