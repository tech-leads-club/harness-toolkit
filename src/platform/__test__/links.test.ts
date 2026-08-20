import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { isLink, LINK_TYPE, linkDir, seedConfig } from "../links.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tlc-links-"));
  dirs.push(dir);
  return dir;
}

function checkout(): string {
  const dir = scratch();
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "tlc"), "#!/bin/sh\n");
  writeFileSync(join(dir, "config.example.json"), '{"version":1}');
  return dir;
}

/**
 * AC4 — one link type for three platforms. Node ignores it outside Windows, so the same call is a junction there
 * and a symlink here; this asserts the value rather than a branch, because there is no branch to assert
 * ([/decisions/ad-097.md](/decisions/ad-097.md)).
 */
test("AC4 the link type is the one Windows reads, and it works where Windows is not", () => {
  assert.equal(LINK_TYPE, "junction");

  const target = join(scratch(), "harness");
  linkDir(checkout(), target);

  assert.equal(lstatSync(target).isSymbolicLink(), true);
});

test("AC1 linkDir points the target at the source, through to its contents", () => {
  const source = checkout();
  const target = join(scratch(), "harness");

  const outcome = linkDir(source, target);

  assert.equal(outcome.kind, "linked");
  assert.equal(readFileSync(join(target, "bin", "tlc"), "utf8"), "#!/bin/sh\n");
});

/** AC3 — a contributor re-running it must not accumulate links or fail. */
test("AC3 a second run against the same source relinks rather than failing", () => {
  const source = checkout();
  const target = join(scratch(), "harness");

  assert.equal(linkDir(source, target).kind, "linked");
  const second = linkDir(source, target);

  assert.equal(second.kind, "relinked");
  assert.equal(lstatSync(target).isSymbolicLink(), true);
});

/**
 * AC2 — hazard: the bash installer ran `rmdir`/`Remove-Item -Recurse` on whatever was at the target. A real
 * directory there is either an install or somebody's work, and both are theirs
 * ([/decisions/ad-046.md](/decisions/ad-046.md)).
 */
test("AC2 a real directory at the target is refused, named, and left intact", () => {
  const target = join(scratch(), "harness");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "MINE.txt"), "keep me\n");

  const outcome = linkDir(checkout(), target);

  assert.equal(outcome.kind, "refused");
  assert.match(outcome.kind === "refused" ? outcome.reason : "", /move it aside/);
  assert.equal(readFileSync(join(target, "MINE.txt"), "utf8").trim(), "keep me");
});

/** hazard: `existsSync` is false for a dangling link, so checking it first would treat one as free space. */
test("a link pointing nowhere is replaced rather than refused", () => {
  const target = join(scratch(), "harness");
  const gone = join(scratch(), "deleted-clone");
  mkdirSync(gone, { recursive: true });
  linkDir(gone, target);
  rmSync(gone, { recursive: true, force: true });

  assert.equal(existsSync(target), false, "a dangling link does not exist by that measure");
  assert.equal(isLink(target), true, "but it is still a link");
  assert.equal(linkDir(checkout(), target).kind, "relinked");
});

test("AC7 config.json is seeded once and never overwritten", () => {
  const dest = checkout();

  assert.equal(seedConfig(dest).seeded, true);
  writeFileSync(join(dest, "config.json"), '{"mine":true}');

  assert.equal(seedConfig(dest).seeded, false);
  assert.equal(readFileSync(join(dest, "config.json"), "utf8"), '{"mine":true}');
});

test("AC7 no example means nothing is seeded, and no throw", () => {
  const dest = scratch();

  assert.doesNotThrow(() => seedConfig(dest));
  assert.equal(seedConfig(dest).seeded, false);
  assert.equal(existsSync(join(dest, "config.json")), false);
});
