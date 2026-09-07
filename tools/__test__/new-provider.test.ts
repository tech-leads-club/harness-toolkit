import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffold, scaffoldFiles, validateProviderName } from "../dev/new-provider.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// why: unlikely to ever collide with a real provider name, and distinctive enough that a leftover from a
// failed test run is obvious in `git status` rather than silently mistaken for real source.
const THROWAWAY_NAME = "scaffoldfixturezz";

function cleanupThrowaway(): void {
  rmSync(join(repoRoot, "src", "providers", THROWAWAY_NAME), { recursive: true, force: true });
  rmSync(join(repoRoot, "docs", "providers", `${THROWAWAY_NAME}.md`), { force: true });
}

test("validateProviderName refuses whitespace, a slash, and reserved names, naming the reason", () => {
  assert.deepEqual(validateProviderName("has space"), {
    ok: false,
    reason: "provider name must not contain whitespace or a slash",
  });
  assert.deepEqual(validateProviderName("has/slash"), {
    ok: false,
    reason: "provider name must not contain whitespace or a slash",
  });
  assert.deepEqual(validateProviderName("index"), { ok: false, reason: '"index" is a reserved name' });
  assert.deepEqual(validateProviderName("provider"), { ok: false, reason: '"provider" is a reserved name' });
  assert.deepEqual(validateProviderName(""), { ok: false, reason: "provider name must not be empty" });
  assert.deepEqual(validateProviderName("acme"), { ok: true });
});

test("scaffoldFiles lists a detect/capabilities/policy-defaults/inbound/wiring stub and a doc for the name", () => {
  const files = scaffoldFiles("acme").map((file) => file.path);
  assert.ok(files.includes(join("src", "providers", "acme", "acme.detect.ts")));
  assert.ok(files.includes(join("src", "providers", "acme", "acme.capabilities.ts")));
  assert.ok(files.includes(join("src", "providers", "acme", "acme.policy-defaults.ts")));
  assert.ok(files.includes(join("src", "providers", "acme", "acme.inbound.ts")));
  assert.ok(files.includes(join("src", "providers", "acme", "acme.wiring.ts")));
  assert.ok(files.includes(join("docs", "providers", "acme.md")));
});

test("scaffold refuses a second run for the same name, naming the existing path", () => {
  cleanupThrowaway();
  try {
    const first = scaffold(THROWAWAY_NAME);
    assert.deepEqual(first, { ok: true });
    assert.ok(existsSync(join(repoRoot, "src", "providers", THROWAWAY_NAME, `${THROWAWAY_NAME}.detect.ts`)));
    assert.ok(existsSync(join(repoRoot, "docs", "providers", `${THROWAWAY_NAME}.md`)));

    const second = scaffold(THROWAWAY_NAME);
    assert.equal(second.ok, false);
    assert.ok(!second.ok && second.reason.includes(join("src", "providers", THROWAWAY_NAME)));
  } finally {
    cleanupThrowaway();
  }
});

test("scaffold refuses an unsafe name without writing anything", () => {
  const scratch = mkdtempSync(join(tmpdir(), "new-provider-"));
  try {
    const result = scaffold("bad name", scratch);
    assert.deepEqual(result, {
      ok: false,
      reason: "provider name must not contain whitespace or a slash",
    });
    assert.equal(existsSync(join(scratch, "src")), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("scaffolded stubs compile under tsc --noEmit, and add no new package.json dependency", () => {
  cleanupThrowaway();
  const packageJsonBefore = readFileSync(join(repoRoot, "package.json"), "utf8");
  try {
    const result = scaffold(THROWAWAY_NAME);
    assert.deepEqual(result, { ok: true });

    const tsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(tsc.status, 0, `tsc --noEmit failed on the scaffolded stubs:\n${tsc.stdout}${tsc.stderr}`);

    const packageJsonAfter = readFileSync(join(repoRoot, "package.json"), "utf8");
    assert.equal(packageJsonAfter, packageJsonBefore, "scaffolding must not touch package.json");
  } finally {
    cleanupThrowaway();
  }
});
