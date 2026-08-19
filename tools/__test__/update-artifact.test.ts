import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  classifyRuntimePath,
  fetchFailureMessage,
  linkedRuntimeMessage,
  missingBundles,
  resetFailureMessage,
  runtimePathKind,
  unmanagedRuntimeMessage,
} from "../../bin/tlc-cli.ts";

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

const NEVER = { isSymlink: () => false, exists: () => false };

test("a real checkout with .git is managed", () => {
  assert.equal(classifyRuntimePath("/r", { isSymlink: () => false, exists: () => true }), "managed");
});

/**
 * hazard: `install.sh` links the runtime path to the clone it was run from, so on a contributor's machine
 * `~/.tlc/harness` is a symlink to their working repository. The old message told them to run `git reset --hard`
 * there ([/decisions/ad-046.md](/decisions/ad-046.md)).
 *
 * invariant: the symlink test comes first. A linked clone contains a `.git` too, so testing for that first would
 * classify somebody's repository as the harness's own artifact.
 */
test("a symlink is linked even though it contains a .git", () => {
  assert.equal(classifyRuntimePath("/r", { isSymlink: () => true, exists: () => true }), "linked");
});

test("a missing path is absent", () => {
  assert.equal(classifyRuntimePath("/r", NEVER), "absent");
});

test("a directory without .git is unmanaged, so git is never invoked on it", () => {
  const kind = classifyRuntimePath("/r", {
    isSymlink: () => false,
    exists: (path) => path === "/r",
  });
  assert.equal(kind, "unmanaged");
});

test("the real classifier agrees with the probe on a symlinked directory", () => {
  const target = newDir("tlc-target-");
  mkdirSync(join(target, ".git"), { recursive: true });
  const link = join(newDir("tlc-link-"), "harness");
  symlinkSync(target, link, "dir");
  assert.equal(runtimePathKind(link), "linked");
  assert.equal(runtimePathKind(target), "managed");
});

/**
 * hazard: only the last hop may decide. An earlier version also read "resolves elsewhere" as linked, to catch a
 * symlinked ancestor. macOS CI refuted it — `/var` links to `/private/var`, so every path under the system temp
 * directory resolves elsewhere and a **managed** checkout classified as linked, which would silently stop updates
 * on that platform ([/decisions/ad-046.md](/decisions/ad-046.md)).
 *
 * This is the regression test for that: a real checkout whose path resolves elsewhere stays `managed`.
 */
test("a managed checkout under a symlinked ancestor is still managed", () => {
  const real = newDir("tlc-real-");
  mkdirSync(join(real, "harness", ".git"), { recursive: true });
  const linkedParent = join(newDir("tlc-parent-"), "tlc");
  symlinkSync(real, linkedParent, "dir");

  const through = join(linkedParent, "harness");
  assert.equal(lstatSync(through).isSymbolicLink(), false, "the last hop is a plain directory");
  assert.equal(runtimePathKind(through), "managed");
  assert.equal(runtimePathKind(join(real, "harness")), "managed");
});

// invariant: `state/` and `config.json` are gitignored, so a hard reset cannot remove them. Asserted rather than
// trusted, because the whole ownership model rests on it.
test("a hard reset at the runtime path keeps untracked state and config", () => {
  const repo = newDir("tlc-reset-");
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@e.c"]);
  git(["config", "user.name", "T"]);
  writeFileSync(join(repo, ".gitignore"), "/state/\nconfig.json\n");
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);

  mkdirSync(join(repo, "state"), { recursive: true });
  writeFileSync(join(repo, "state", "lessons.json"), '{"version":1,"lessons":[]}');
  writeFileSync(join(repo, "config.json"), '{"version":1}');
  writeFileSync(join(repo, "tracked.txt"), "locally edited\n");

  execFileSync("git", ["-C", repo, "reset", "--hard", "HEAD"], { stdio: "ignore" });

  assert.equal(existsSync(join(repo, "state", "lessons.json")), true, "global lessons must survive");
  assert.equal(existsSync(join(repo, "config.json")), true, "runtime config must survive");
});

test("no bundle is missing when every entrypoint has one", () => {
  const dest = newDir("tlc-bundles-");
  mkdirSync(join(dest, "src", "entrypoints"), { recursive: true });
  mkdirSync(join(dest, "dist"), { recursive: true });
  for (const name of ["stop", "session-start"]) {
    writeFileSync(join(dest, "src", "entrypoints", `${name}.ts`), "");
    writeFileSync(join(dest, "dist", `${name}.mjs`), "");
  }
  assert.deepEqual(missingBundles(dest), []);
});

// why: derived from the entrypoints on disk the way `bin/tlc-build` derives them. A fixed list would stop naming a
// new entrypoint and the absent bundle would only surface when a hook fired.
test("an entrypoint with no bundle is reported", () => {
  const dest = newDir("tlc-bundles-");
  mkdirSync(join(dest, "src", "entrypoints"), { recursive: true });
  mkdirSync(join(dest, "dist"), { recursive: true });
  writeFileSync(join(dest, "src", "entrypoints", "stop.ts"), "");
  writeFileSync(join(dest, "src", "entrypoints", "session-start.ts"), "");
  writeFileSync(join(dest, "dist", "stop.mjs"), "");
  assert.deepEqual(missingBundles(dest), ["session-start.mjs"]);
});

test("a test file is not an entrypoint", () => {
  const dest = newDir("tlc-bundles-");
  mkdirSync(join(dest, "src", "entrypoints"), { recursive: true });
  mkdirSync(join(dest, "dist"), { recursive: true });
  writeFileSync(join(dest, "src", "entrypoints", "stop.test.ts"), "");
  assert.deepEqual(missingBundles(dest), []);
});

test("no entrypoints directory reports nothing rather than throwing", () => {
  assert.deepEqual(missingBundles(newDir("tlc-bundles-")), []);
});

test("the linked message names the clone and refuses to touch it", () => {
  const text = linkedRuntimeMessage("/opt/runtime", "/opt/clone/harness");
  assert.match(text, /link to a working clone → \/opt\/clone\/harness/);
  // invariant: the path it is talking about, like every sibling message. It was accepted and dropped.
  assert.match(text, /\/opt\/runtime/);
  assert.match(text, /Nothing in it is touched/);
  assert.match(text, /your own `git pull`/);
  assert.doesNotMatch(text, /reset --hard/);
});

test("the linked message works without a resolvable target", () => {
  assert.match(linkedRuntimeMessage("/x", null), /link to a working clone\./);
});

/**
 * hazard: a bare `update: git fetch failed.` names a transport problem and not the route that works. An install
 * predating the move to the org sees the same line for a different reason, and the package is the answer to both
 * ([/decisions/ad-082.md](/decisions/ad-082.md)).
 */
test("a failed fetch names the package route and the move, not just the failure", () => {
  const text = fetchFailureMessage("/opt/runtime");
  assert.match(text, /\/opt\/runtime/);
  assert.match(text, /npm i -g @tech-leads-club\/harness-toolkit@latest/);
  assert.match(text, /tlc harness install/);
  assert.match(text, /tech-leads-club\/harness-toolkit/);
  // why: a private fork is the one case left where a credential is the cause, so it is still named — last.
  assert.match(text, /gh auth setup-git/);
});

// invariant: no message may name `reset --hard` against a path the harness has not established it owns, and none
// may offer re-running the installer as a way to replace the checkout — `install.sh` runs `git pull --ff-only`,
// the command that just failed.
test("no message offers a remedy the harness does not perform", () => {
  const messages = [
    linkedRuntimeMessage("/x", "/y"),
    unmanagedRuntimeMessage("/x"),
    resetFailureMessage("/x", "origin/main", "fatal: something"),
  ];
  for (const text of messages) {
    assert.doesNotMatch(text, /reset --hard/, text);
    assert.doesNotMatch(text, /replaces the checkout/, text);
  }
});

test("the unmanaged message points at the package, not at git", () => {
  const text = unmanagedRuntimeMessage("/opt/harness");
  assert.match(text, /not a git checkout/);
  assert.match(text, /npm i -g @tech-leads-club\/harness-toolkit@latest/);
  assert.match(text, /tlc harness install/);
});

test("a reset failure reports the path kind and the tail of git's output", () => {
  const text = resetFailureMessage("/x", "origin/main", "line1\nline2\nline3\nline4\n");
  assert.match(text, /managed checkout/);
  assert.match(text, /line2 \/ line3 \/ line4/);
  assert.doesNotMatch(text, /line1/);
  assert.match(text, /Nothing was changed/);
});

test("a reset failure with no git output still says what happened", () => {
  const text = resetFailureMessage("/x", "origin/main", "   ");
  assert.match(text, /could not move the runtime to origin\/main/);
  assert.doesNotMatch(text, /git:/);
});
