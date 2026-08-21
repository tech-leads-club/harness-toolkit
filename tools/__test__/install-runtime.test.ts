import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launcherLines, NPM_MARKER } from "../../bin/tlc-cli.ts";
import { isLink } from "../../src/platform/links.ts";
import {
  installDest,
  installReportText,
  installRuntime,
  isShipped,
  linkRuntime,
  OPERATOR_OWNED,
  originRoot,
  RUNTIME_PAYLOAD,
} from "../install-runtime.ts";
import { uninstallTargets } from "../uninstall-runtime.ts";

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
  // why: the published package ships the launcher wrapper, and wiring links it. A fixture without it made the
  // link dangle, which is how the missing-source guard was found.
  writeFileSync(join(root, "bin", "tlc"), "#!/usr/bin/env bash\n", "utf8");
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

/**
 * hazard: the guard above compared resolved paths, and `resolve` does not follow a symlink. An operator who
 * installed with `--link` has a runtime home that *is* a link to their checkout, so the two paths differed
 * lexically while naming one directory: the guard missed, `rmSync` followed the link, and the first payload entry
 * deleted the checkout's own `bin/` before `cpSync` failed on the source it had just removed. Measured on this
 * repository, mid-gate ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
test("a destination that is a link to the source copies nothing and deletes nothing", () => {
  const source = fakePackage();
  const link = join(tempDir("linked-"), "harness");
  try {
    symlinkSync(source, link, "junction");

    const report = installRuntime(source, link);

    assert.equal(report.kind, "in-place");
    assert.ok(existsSync(join(source, "bin")), "the checkout still has its bin/");
    assert.ok(existsSync(join(source, "dist")), "and everything else the payload names");
  } finally {
    rmSync(link, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
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

/**
 * hazard: the exclusion used to be a hand-maintained array in the build script. It named four checkers while ten
 * qualified, so six that validate only this repository were bundled and copied into every install for weeks. The
 * directory is the declaration now, and these are the two product routes that must honour it.
 */
test("no product route carries the repo-only checks", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const dest = mkdtempSync(join(tmpdir(), "tlc-ship-"));

  installRuntime(repoRoot, dest);
  assert.equal(existsSync(join(dest, "tools", "dev")), false, "tlc harness install");
  assert.equal(existsSync(join(dest, "tools", "__test__")), false, "tests are not payload either");
  assert.equal(existsSync(join(dest, "tools", "doctor.ts")), true, "the product tools still arrive");

  const published = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { files: string[] })
    .files;
  assert.equal(published.includes("!tools/dev"), true, "npm package");

  rmSync(dest, { recursive: true, force: true });
});

test("isShipped answers for a path inside an excluded directory, not just the directory", () => {
  assert.equal(isShipped(join("tools", "dev")), false);
  assert.equal(isShipped(join("tools", "dev", "check-wiring.ts")), false);
  assert.equal(isShipped(join("tools", "dev", "nested", "deep.ts")), false);
  // invariant: a sibling whose name merely starts with the excluded one still ships.
  assert.equal(isShipped(join("tools", "developer-notes.ts")), true);
  assert.equal(isShipped(join("tools", "doctor.ts")), true);
});

test("every bundle in dist has a source outside tools/dev", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  for (const bundle of readdirSync(join(repoRoot, "dist")).filter((f) => f.endsWith(".mjs"))) {
    const name = bundle.replace(/\.mjs$/, "");
    if (name === "tlc-cli") {
      continue;
    }
    const shipped =
      existsSync(join(repoRoot, "src", "entrypoints", `${name}.ts`)) ||
      existsSync(join(repoRoot, "tools", `${name}.ts`));
    assert.equal(shipped, true, `${bundle} has no shipped source`);
  }
});

/**
 * The contributor route. It was `ln -sfn` in bash and `mklink /J` in PowerShell — two implementations, one of
 * which asked for Developer Mode ([/decisions/ad-097.md](/decisions/ad-097.md)).
 */
test("AC1 --link points the runtime home at the checkout, not at a copy", () => {
  const source = fakePackage();
  const dest = join(tempDir("home-"), "harness");

  const report = linkRuntime(source, dest);

  assert.equal(report.kind, "linked");
  assert.equal(lstatSync(dest).isSymbolicLink(), true, "a copy would not be a link");
  assert.equal(readFileSync(join(dest, "bin", "marker.txt"), "utf8"), "bin");
});

/** invariant: an edit in the checkout is visible through the link, which is the whole point of the route. */
test("AC1 an edit in the checkout is live through the link", () => {
  const source = fakePackage();
  const dest = join(tempDir("home-"), "harness");
  linkRuntime(source, dest);

  writeFileSync(join(source, "bin", "marker.txt"), "edited", "utf8");

  assert.equal(readFileSync(join(dest, "bin", "marker.txt"), "utf8"), "edited");
});

test("AC3 linking twice relinks and leaves one link", () => {
  const source = fakePackage();
  const dest = join(tempDir("home-"), "harness");

  assert.equal(linkRuntime(source, dest).kind, "linked");
  assert.equal(linkRuntime(source, dest).kind, "relinked");
  assert.equal(lstatSync(dest).isSymbolicLink(), true);
});

/**
 * AC2 — hazard: both scripts removed whatever was at the destination. A real directory there is an existing
 * install or somebody's work ([/decisions/ad-046.md](/decisions/ad-046.md)).
 */
test("AC2 an existing real runtime directory is refused and left alone", () => {
  const source = fakePackage();
  const dest = join(tempDir("home-"), "harness");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "config.json"), '{"mine":true}');

  const report = linkRuntime(source, dest);

  assert.equal(report.kind, "refused");
  assert.match(report.reason ?? "", /move it aside/);
  assert.equal(readFileSync(join(dest, "config.json"), "utf8"), '{"mine":true}');
});

/** why: linking the runtime home to itself is not an error, it is a contributor who already did it. */
test("linking a checkout to itself is reported as already in place", () => {
  const source = fakePackage();

  assert.equal(linkRuntime(source, source).kind, "in-place");
});

/** invariant: a checkout that was never built is named as incomplete rather than reported as a good install. */
test("a checkout missing a payload entry is linked and reported incomplete", () => {
  const source = fakePackage();
  rmSync(join(source, "dist"), { recursive: true, force: true });
  const dest = join(tempDir("home-"), "harness");

  const report = linkRuntime(source, dest);

  assert.equal(report.kind, "linked");
  assert.deepEqual(report.missing, ["dist"]);
  assert.match(installReportText(report), /incomplete/);
});

test("the refusal is what the operator reads, not a stack", () => {
  const dest = join(tempDir("home-"), "harness");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "keep"), "x");

  assert.match(installReportText(linkRuntime(fakePackage(), dest)), /refused/);
});

/**
 * hazard: `install` put the code in place and wired nothing — the provider hooks and the skill links came from
 * the tail of the shell installer, so deleting that script left `npm i -g` + `tlc harness install` with two empty
 * provider directories and a harness that did nothing until `update` happened to run. Found by installing the
 * published package on a clean machine ([/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * invariant: the command that installs is the command that wires, through the same function `update` uses.
 */
test("AC install wires the providers, not only the runtime directory", () => {
  const source = readFileSync(join(repoRoot, "tools", "install-runtime.ts"), "utf8");
  const main = source.slice(source.indexOf("if (import.meta.main)"));

  assert.match(main, /wireRuntime\(/, "install must wire, or a fresh machine gets no hooks and no skill");
  assert.ok(
    main.indexOf("installReportText") < main.indexOf("wireRuntime("),
    "the runtime lands before it is wired",
  );
  assert.match(main, /fetchPrices\(/, "and the first price fetch stays");
});

/**
 * hazard: install never created the `tlc` launcher. `uninstall` removed it, `doctor` failed without it, and the
 * README said install added it — three halves of a thing that did not exist. The command came from npm's own shim,
 * which lives in the bin directory of whichever Node version npm ran under and leaves `PATH` the moment a version
 * manager switches. Measured on an operator's machine: a successful install, then `tlc: command not found`
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
test("wiring links the tlc launcher into the bin directory and names it", () => {
  const dest = fakePackage();
  const bin = tempDir("bin-");
  const previous = process.env.TLC_BIN_DIR;
  process.env.TLC_BIN_DIR = bin;
  try {
    const lines = launcherLines(dest);

    assert.equal(existsSync(join(bin, "tlc")), true);
    assert.ok(
      lines.some((line) => line.includes(join(bin, "tlc"))),
      lines.join(" | "),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.TLC_BIN_DIR;
    } else {
      process.env.TLC_BIN_DIR = previous;
    }
    rmSync(dest, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

/**
 * invariant: a link nobody can reach is worse than none, because `doctor` then reports it healthy while the command
 * still does not exist.
 */
test("a bin directory that is not on PATH is said so", () => {
  const dest = fakePackage();
  const bin = tempDir("offpath-");
  const previous = process.env.TLC_BIN_DIR;
  process.env.TLC_BIN_DIR = bin;
  try {
    assert.ok(
      launcherLines(dest).some((line) => line.includes("not on PATH")),
      "the operator has to be told",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.TLC_BIN_DIR;
    } else {
      process.env.TLC_BIN_DIR = previous;
    }
    rmSync(dest, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

/** AC — install links what uninstall removes. One definition, so the two halves cannot drift apart. */
test("the path install links is the path uninstall removes", () => {
  const bin = tempDir("agree-");
  try {
    assert.ok(
      uninstallTargets({ TLC_BIN_DIR: bin }).binLinks.includes(join(bin, "tlc")),
      "uninstall must name the launcher install creates",
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

/**
 * hazard: the two tests above call `launcherLines` directly, so removing its call from `wireRuntime` left them
 * green — a function that works and is wired to nothing, which is the exact shape this repository keeps finding.
 * `wireRuntime` cannot be run here: it spawns the hook writer, which reads the real provider config directories,
 * so the wiring is asserted on the source instead ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
test("wireRuntime calls the launcher step", () => {
  const source = readFileSync(join(repoRoot, "bin", "tlc-cli.ts"), "utf8");
  const body = source.slice(source.indexOf("export function wireRuntime"));

  assert.match(body.slice(0, body.indexOf("\n}")), /launcherLines\(dest\)/);
});

/** invariant: a launcher pointing at nothing must not be created — `existsSync` on a dangling link is false. */
test("a runtime with no launcher wrapper is reported, not linked to nothing", () => {
  const dest = tempDir("nolauncher-");
  const bin = tempDir("bin2-");
  const previous = process.env.TLC_BIN_DIR;
  process.env.TLC_BIN_DIR = bin;
  try {
    const lines = launcherLines(dest);

    assert.ok(
      lines.some((line) => /not linked — .*is missing from the runtime/.test(line)),
      lines.join(" | "),
    );
    assert.equal(isLink(join(bin, "tlc")), false, "nothing was created");
  } finally {
    if (previous === undefined) {
      delete process.env.TLC_BIN_DIR;
    } else {
      process.env.TLC_BIN_DIR = previous;
    }
    rmSync(dest, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
