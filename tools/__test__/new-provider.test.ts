import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendProviderToRegistry,
  runNewProvider,
  scaffold,
  scaffoldFiles,
  validateProviderName,
} from "../dev/new-provider.ts";

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
    const docPath = join(repoRoot, "docs", "providers", `${THROWAWAY_NAME}.md`);
    assert.ok(existsSync(docPath));
    const doc = readFileSync(docPath, "utf8");
    for (const heading of [
      "## Detection",
      "## Capability descriptor",
      "## Policy defaults",
      "## Event mapping",
      "## Wiring target",
    ]) {
      assert.ok(doc.includes(heading), `doc missing heading: ${heading}`);
    }

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

    // hazard: on Windows `npx` is `npx.cmd`, and spawnSync does not consult PATHEXT without a shell — the
    // exit code reads back as `null` there while passing everywhere else ([/decisions/ad-097.md](/decisions/ad-097.md)).
    const tsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: repoRoot, encoding: "utf8", shell: true });
    assert.equal(tsc.status, 0, `tsc --noEmit failed on the scaffolded stubs:\n${tsc.stdout}${tsc.stderr}`);

    const packageJsonAfter = readFileSync(join(repoRoot, "package.json"), "utf8");
    assert.equal(packageJsonAfter, packageJsonBefore, "scaffolding must not touch package.json");
  } finally {
    cleanupThrowaway();
  }
});

describe("appendProviderToRegistry", () => {
  test("appends the new provider after the existing two, unchanged in order", () => {
    const current = readFileSync(join(repoRoot, "src", "providers", "provider.registry.ts"), "utf8");
    assert.match(current, /export const providers: ProviderPort\[\] = \[cursorProvider, claudeProvider\];/);

    const next = appendProviderToRegistry(current, "acme");

    assert.match(next, /import \{ acmeProvider \} from "\.\/acme\/index\.ts";/);
    assert.match(
      next,
      /export const providers: ProviderPort\[\] = \[cursorProvider, claudeProvider, acmeProvider\];/,
    );
    // why: cursor/claude's own imports are untouched — only a new line and the array literal changed.
    assert.match(next, /import \{ claudeProvider \} from "\.\/claude\/index\.ts";/);
    assert.match(next, /import \{ cursorProvider \} from "\.\/cursor\/index\.ts";/);
  });

  test("throws naming the gap when the type-import anchor is missing", () => {
    assert.throws(() => appendProviderToRegistry("no imports here", "acme"), /could not find/);
  });
});

describe("runNewProvider", () => {
  function scratchWithRegistry(): string {
    const root = mkdtempSync(join(tmpdir(), "tlc-new-provider-"));
    mkdirSync(join(root, "src", "providers"), { recursive: true });
    writeFileSync(
      join(root, "src", "providers", "provider.registry.ts"),
      [
        'import { claudeProvider } from "./claude/index.ts";',
        'import { cursorProvider } from "./cursor/index.ts";',
        'import type { ProviderPort } from "./provider.port.ts";',
        "",
        "export const providers: ProviderPort[] = [cursorProvider, claudeProvider];",
        "",
      ].join("\n"),
      "utf8",
    );
    return root;
  }

  test("scaffolds the stubs and appends the registry line, in that order", () => {
    const root = scratchWithRegistry();
    try {
      const result = runNewProvider("acme", root);
      assert.deepEqual(result, { ok: true });
      assert.ok(existsSync(join(root, "src", "providers", "acme", "acme.detect.ts")));
      const registry = readFileSync(join(root, "src", "providers", "provider.registry.ts"), "utf8");
      assert.match(
        registry,
        /export const providers: ProviderPort\[\] = \[cursorProvider, claudeProvider, acmeProvider\];/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a refused scaffold (unsafe name) never touches the registry", () => {
    const root = scratchWithRegistry();
    try {
      const before = readFileSync(join(root, "src", "providers", "provider.registry.ts"), "utf8");
      const result = runNewProvider("bad name", root);
      assert.equal(result.ok, false);
      const after = readFileSync(join(root, "src", "providers", "provider.registry.ts"), "utf8");
      assert.equal(after, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
