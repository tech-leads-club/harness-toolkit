import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { runtimeOwnershipCheck } from "../doctor.ts";

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

// why: both kinds are supported installs, so both are `ok`. A contributor whose runtime links their own clone needs
// to see that, or `update` declining to pull reads as a broken update.
test("a managed checkout is healthy and says update owns it", () => {
  const home = newDir("tlc-doctor-managed-");
  mkdirSync(join(home, ".git"), { recursive: true });
  const check = runtimeOwnershipCheck(home);
  assert.equal(check.level, "ok");
  assert.match(check.detail, /managed checkout/);
  assert.match(check.detail, /owns its contents/);
});

test("a linked clone is healthy and says update never writes there", () => {
  const target = newDir("tlc-doctor-clone-");
  mkdirSync(join(target, ".git"), { recursive: true });
  const link = join(newDir("tlc-doctor-link-"), "harness");
  symlinkSync(target, link, "dir");
  const check = runtimeOwnershipCheck(link);
  assert.equal(check.level, "ok");
  assert.match(check.detail, /link to a working clone/);
  assert.match(check.detail, /never writes here/);
});

// invariant: an install update cannot move is a failure, not a warning — the operator would keep running a stale
// runtime and every `update` would report success.
test("a directory that is not a checkout fails", () => {
  const check = runtimeOwnershipCheck(newDir("tlc-doctor-plain-"));
  assert.equal(check.level, "fail");
  assert.match(check.detail, /not a git checkout/);
});

test("a missing install fails and names the command that puts the runtime in place", () => {
  const check = runtimeOwnershipCheck(join(newDir("tlc-doctor-gone-"), "absent"));
  assert.equal(check.level, "fail");
  assert.match(check.detail, /tlc harness install/);
});

// invariant: no doctor row hands the operator a command that could write to a path the harness does not own.
test("no ownership detail names a destructive git command", () => {
  const target = newDir("tlc-doctor-clone-");
  mkdirSync(join(target, ".git"), { recursive: true });
  const link = join(newDir("tlc-doctor-link-"), "harness");
  symlinkSync(target, link, "dir");
  for (const home of [target, link, newDir("tlc-doctor-plain-")]) {
    assert.doesNotMatch(runtimeOwnershipCheck(home).detail, /reset --hard/);
  }
});
