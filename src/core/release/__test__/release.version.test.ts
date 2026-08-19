import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseVersion, tagPrefixFor, versionInTag } from "../release.version.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

describe("tagPrefixFor", () => {
  test("a scoped name loses its scope, an unscoped one is used as it is", () => {
    assert.equal(tagPrefixFor("@tech-leads-club/harness-toolkit"), "harness-toolkit-v");
    assert.equal(tagPrefixFor("harness-toolkit"), "harness-toolkit-v");
  });

  /**
   * hazard: this is the assertion that would have caught the shipped defect. The changelog generator globbed `v*`
   * and matched none of the three existing tags, so every decision record read as unreleased.
   */
  test("the prefix matches the tags this repository has actually created", () => {
    const { name } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { name: string };

    assert.equal(tagPrefixFor(name), "harness-toolkit-v");
    assert.equal(versionInTag(name, "harness-toolkit-v0.2.2"), "0.2.2");
  });
});

describe("versionInTag", () => {
  const name = "@tech-leads-club/harness-toolkit";

  test("a tag for this package yields its version", () => {
    assert.equal(versionInTag(name, "harness-toolkit-v1.0.0"), "1.0.0");
    assert.equal(versionInTag(name, "harness-toolkit-v0.0.1"), "0.0.1");
  });

  test("a tag for another package, or another scheme, is null", () => {
    for (const tag of [
      "v1.0.0",
      "agent-skills-v1.4.9",
      "harness-toolkit-1.0.0",
      "harness-toolkit-vlatest",
      "",
    ]) {
      assert.equal(versionInTag(name, tag), null, tag);
    }
  });
});

describe("parseVersion", () => {
  test("a three-part version parses and anything else is null", () => {
    assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parseVersion(" 0.0.1 "), { major: 0, minor: 0, patch: 1 });
    for (const bad of ["1.2", "1.2.3-rc.1", "v1.2.3", "", "x"]) {
      assert.equal(parseVersion(bad), null, bad);
    }
  });
});
