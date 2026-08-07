import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NPM_MARKER } from "../../bin/tlc-cli.ts";
import {
  installDest,
  installReportText,
  installRuntime,
  OPERATOR_OWNED,
  originRoot,
  RUNTIME_PAYLOAD,
} from "../install-runtime.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakePackage(): string {
  const root = tempDir("pkg-");
  for (const entry of RUNTIME_PAYLOAD) {
    if (entry.endsWith(".json")) {
      writeFileSync(join(root, entry), `{"from":"${entry}"}`, "utf8");
      continue;
    }
    mkdirSync(join(root, entry), { recursive: true });
    writeFileSync(join(root, entry, "marker.txt"), entry, "utf8");
  }
  return root;
}

test("installing copies the payload and leaves nothing else behind", () => {
  const source = fakePackage();
  const dest = tempDir("home-");
  try {
    const report = installRuntime(source, dest);
    assert.equal(report.kind, "copied");
    assert.deepEqual(report.missing, []);
    for (const entry of RUNTIME_PAYLOAD) {
      assert.ok(existsSync(join(dest, entry)), `${entry} was not installed`);
    }
    assert.ok(existsSync(join(dest, NPM_MARKER)), "the marker says what created this directory");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

// why: this is the whole reason the split exists. An npm update replaces the package directory, and if the
// operator's data lived there it would go with it.
test("everything the operator owns survives a re-install", () => {
  const source = fakePackage();
  const dest = tempDir("home-");
  try {
    installRuntime(source, dest);
    writeFileSync(join(dest, "config.json"), '{"mine":true}', "utf8");
    mkdirSync(join(dest, "state"), { recursive: true });
    writeFileSync(join(dest, "state", "lessons.json"), '{"lessons":[1]}', "utf8");
    mkdirSync(join(dest, "flags"), { recursive: true });
    writeFileSync(join(dest, "flags", "paused"), "", "utf8");

    installRuntime(source, dest);

    assert.equal(readFileSync(join(dest, "config.json"), "utf8"), '{"mine":true}');
    assert.equal(readFileSync(join(dest, "state", "lessons.json"), "utf8"), '{"lessons":[1]}');
    assert.ok(existsSync(join(dest, "flags", "paused")));
    for (const owned of OPERATOR_OWNED) {
      assert.ok(!RUNTIME_PAYLOAD.includes(owned as never), `${owned} must not be in the payload`);
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("a file deleted upstream does not survive the sync", () => {
  const source = fakePackage();
  const dest = tempDir("home-");
  try {
    installRuntime(source, dest);
    writeFileSync(join(dest, "dist", "gone.mjs"), "stale", "utf8");
    installRuntime(source, dest);
    assert.ok(!existsSync(join(dest, "dist", "gone.mjs")), "a stale bundle would keep being executed");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("config.json is seeded from the example only when absent", () => {
  const source = fakePackage();
  const dest = tempDir("home-");
  try {
    installRuntime(source, dest);
    assert.equal(readFileSync(join(dest, "config.json"), "utf8"), '{"from":"config.example.json"}');
    writeFileSync(join(dest, "config.json"), '{"edited":true}', "utf8");
    installRuntime(source, dest);
    assert.equal(readFileSync(join(dest, "config.json"), "utf8"), '{"edited":true}');
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

// hazard: copying a directory onto itself is the one input that turns a sync into data loss. The git route has
// the code at the destination already.
test("source equal to destination copies nothing", () => {
  const root = fakePackage();
  try {
    const report = installRuntime(root, root);
    assert.equal(report.kind, "in-place");
    assert.deepEqual(report.entries, []);
    assert.match(installReportText(report), /already at/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a payload entry missing from the source is reported, not passed over", () => {
  const source = fakePackage();
  const dest = tempDir("home-");
  try {
    rmSync(join(source, "tools"), { recursive: true, force: true });
    const report = installRuntime(source, dest);
    assert.deepEqual(report.missing, ["tools"]);
    assert.match(installReportText(report), /MISSING from the source: tools/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

// hazard: the expectation has to be computed the way the code computes it. Literal POSIX paths passed on Linux
// and macOS and failed on Windows, where `resolve` prepends the drive and flips the separators.
test("the origin is the launcher's own directory, not the resolved home", () => {
  const pkg = join("pkg", "root");
  const home = join("home", "run");
  assert.equal(originRoot({ TLC_ORIGIN: pkg }), resolve(pkg));
  assert.equal(originRoot({ TLC_ORIGIN: "  ", TLC_HOME: home }), resolve(home));
});

/**
 * hazard: `tools/` was absent from the published `files` list, so the first packed tarball shipped a runtime that
 * could not run `doctor`, `help` or `init` under Bun. The payload and the tarball have to agree, and only this
 * asserts it.
 */
test("every payload entry is something the published package actually ships", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { files: string[] };
  const shipped = new Set(
    pkg.files.filter((entry) => !entry.startsWith("!")).map((e) => e.replace(/\/$/, "")),
  );
  const absent = RUNTIME_PAYLOAD.filter((entry) => !shipped.has(entry) && entry !== "package.json");
  assert.deepEqual(absent, [], "payload entries missing from package.json files");
});

/**
 * hazard: `tlc harness install` reaches this tool through the CLI, so the launcher runs twice. The second one
 * saw the TLC_HOME the first had just set, read it as the operator's choice, and resolved the destination to the
 * package directory — installing the runtime on top of itself. Found by running the packed tarball, not by any
 * unit test, which is why the nesting is asserted here.
 */
test("a nested launcher does not turn its own TLC_HOME into an operator choice", () => {
  const pkg = join("usr", "lib", "node_modules", "@tech-leads-club", "harness-toolkit");
  const outer = { TLC_INSTALL_DEST: "", TLC_HOME: pkg, TLC_HOME_FROM_ENV: "0" };
  assert.notEqual(installDest(outer), pkg, "the destination must not be the package it came from");

  const chosen = { TLC_HOME: join("opt", "harness"), TLC_HOME_FROM_ENV: "1" };
  assert.equal(installDest(chosen), join("opt", "harness"), "an operator's own TLC_HOME is still honoured");

  const explicit = join("explicit", "dest");
  assert.equal(installDest({ TLC_INSTALL_DEST: explicit, TLC_HOME_FROM_ENV: "1" }), resolve(explicit));
});
