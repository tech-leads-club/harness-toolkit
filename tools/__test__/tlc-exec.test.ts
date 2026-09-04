import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  childEnv,
  decideRuntime,
  entrySourceCandidates,
  findBunOnPath,
  HOOK_ENTRIES,
  isPackagedCopy,
  MIN_NODE_MAJOR,
  resolveBunPath,
  resolveEntrySource,
  resolveHarnessHome,
  runtimeCachePath,
  takeProviderHint,
  writeRuntimeCache,
} from "../../bin/tlc-exec.mjs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const launcher = join(repoRoot, "bin", "tlc-exec.mjs");

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-exec-"));
}

const cleanupRoots: string[] = [];

function newRoot(): string {
  const root = fixtureRoot();
  cleanupRoots.push(root);
  return root;
}

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("resolveHarnessHome", () => {
  test("prefers TLC_HOME env var when set", () => {
    const home = resolveHarnessHome("/some/bin", { TLC_HOME: "/custom/home" });
    assert.equal(home, "/custom/home");
  });

  // hazard: the expected value has to come from join, since it is what the code uses. A literal
  // "/repo" passed everywhere except Windows, where join returns a backslash separator.
  test("trims whitespace-only TLC_HOME and falls back to bin/..", () => {
    const home = resolveHarnessHome(join("/repo", "bin"), { TLC_HOME: "  " });
    assert.equal(home, join("/repo"));
  });

  test("falls back to the parent of binDir when unset", () => {
    const home = resolveHarnessHome(join("/repo", "bin"), {});
    assert.equal(home, join("/repo"));
  });
});

describe("findBunOnPath", () => {
  test("finds bun when a PATH entry contains it", () => {
    const root = newRoot();
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, "bun"), "");
    const found = findBunOnPath({ PATH: [dirA, dirB].join(delimiter) });
    assert.equal(found, join(dirB, "bun"));
  });

  // invariant: the Windows name is found by the same call, with no platform to pass. There is one lookup, so
  // there is one behaviour to test ([/decisions/ad-097.md](/decisions/ad-097.md)).
  test("finds bun.exe, the name Windows uses, without being told the platform", () => {
    const root = newRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "bun.exe"), "");

    assert.equal(findBunOnPath({ PATH: root }), join(root, "bun.exe"));
  });

  // why: the bare name wins when both are present, so a POSIX machine is never sent to a stray .exe.
  test("the bare name is preferred when both exist", () => {
    const root = newRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "bun"), "");
    writeFileSync(join(root, "bun.exe"), "");

    assert.equal(findBunOnPath({ PATH: root }), join(root, "bun"));
  });

  test("returns null when no PATH entry has bun", () => {
    const root = newRoot();
    mkdirSync(root, { recursive: true });
    const found = findBunOnPath({ PATH: root });
    assert.equal(found, null);
  });

  test("returns null for an empty PATH", () => {
    const found = findBunOnPath({ PATH: "" });
    assert.equal(found, null);
  });
});

describe("resolveBunPath caching", () => {
  test("writes a cache file on first probe", () => {
    const root = newRoot();
    const dir = join(root, "withbun");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bun"), "");
    const found = resolveBunPath(root, { PATH: dir }, "linux");
    assert.equal(found, join(dir, "bun"));
    assert.ok(existsSync(runtimeCachePath(root)));
    const cached = JSON.parse(readFileSync(runtimeCachePath(root), "utf8"));
    assert.equal(cached.bunPath, join(dir, "bun"));
    assert.ok(typeof cached.checkedAt === "string");
  });

  test("trusts an existing cache instead of re-probing PATH", () => {
    const root = newRoot();
    writeRuntimeCache(root, "/fake/never/probed/bun");
    const dir = join(root, "withbun");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bun"), "");
    const found = resolveBunPath(root, { PATH: dir }, "linux");
    assert.equal(found, "/fake/never/probed/bun");
  });

  test("caches a null result when bun is absent", () => {
    const root = newRoot();
    const found = resolveBunPath(root, { PATH: "" }, "linux");
    assert.equal(found, null);
    const cached = JSON.parse(readFileSync(runtimeCachePath(root), "utf8"));
    assert.equal(cached.bunPath, null);
  });
});

describe("entrySourceCandidates / resolveEntrySource", () => {
  test("special-cases tlc-cli to bin/tlc-cli.ts", () => {
    const candidates = entrySourceCandidates("/repo", "tlc-cli");
    assert.deepEqual(candidates, [
      join("/repo", "bin", "tlc-cli.ts"),
      join("/repo", "src", "entrypoints", "tlc-cli.ts"),
      join("/repo", "src", "tlc-cli.ts"),
      join("/repo", "tools", "tlc-cli.ts"),
    ]);
  });

  test("other entries check src/entrypoints, src/ and tools/", () => {
    const candidates = entrySourceCandidates("/repo", "doctor");
    assert.deepEqual(candidates, [
      join("/repo", "src", "entrypoints", "doctor.ts"),
      join("/repo", "src", "doctor.ts"),
      join("/repo", "tools", "doctor.ts"),
    ]);
  });

  test("a hook entrypoint resolves under src/entrypoints — the path the Bun fast path needs", () => {
    const root = newRoot();
    mkdirSync(join(root, "src", "entrypoints"), { recursive: true });
    writeFileSync(join(root, "src", "entrypoints", "tool-before.ts"), "");
    assert.equal(resolveEntrySource(root, "tool-before"), join(root, "src", "entrypoints", "tool-before.ts"));
  });

  test("resolveEntrySource finds the first existing candidate", () => {
    const root = newRoot();
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "tools", "doctor.ts"), "");
    assert.equal(resolveEntrySource(root, "doctor"), join(root, "tools", "doctor.ts"));
  });

  test("resolveEntrySource returns null when nothing exists", () => {
    const root = newRoot();
    assert.equal(resolveEntrySource(root, "doctor"), null);
  });
});

describe("decideRuntime", () => {
  const base = { harnessHome: "/repo", entry: "stop", srcPath: "/repo/src/entrypoints/stop.ts" };

  test("prefers Bun over Node+dist when both are available", () => {
    const decision = decideRuntime({ ...base, bunPath: "/usr/bin/bun", nodeMajor: 24, distExists: true });
    assert.deepEqual(decision, {
      kind: "run",
      command: "/usr/bin/bun",
      args: ["run", "/repo/src/entrypoints/stop.ts"],
    });
  });

  test("falls back to Node+dist when Bun is absent", () => {
    const decision = decideRuntime({ ...base, bunPath: null, nodeMajor: 24, distExists: true });
    assert.deepEqual(decision, {
      kind: "run",
      command: process.execPath,
      args: [join("/repo", "dist", "stop.mjs")],
    });
  });

  test("uses Bun even without a dist bundle", () => {
    const decision = decideRuntime({ ...base, bunPath: "/usr/bin/bun", nodeMajor: 22, distExists: false });
    assert.deepEqual(decision, {
      kind: "run",
      command: "/usr/bin/bun",
      args: ["run", "/repo/src/entrypoints/stop.ts"],
    });
  });

  test("errors pointing at tlc-build when Node is new enough but dist is missing and Bun is absent", () => {
    const decision = decideRuntime({ ...base, bunPath: null, nodeMajor: 24, distExists: false });
    assert.equal(decision.kind, "error");
    assert.match(decision.message, /dist\/stop\.mjs is missing/);
    assert.match(decision.message, /tlc-build/);
  });

  test("names both escapes when neither Bun nor a supported Node is available", () => {
    const decision = decideRuntime({ ...base, bunPath: null, nodeMajor: 18, distExists: false });
    assert.equal(decision.kind, "error");
    // why: a runtime failure that names only one fix leaves anyone who cannot upgrade Node with no way out.
    assert.match(decision.message, /bun\.sh/);
    assert.match(decision.message, /nodejs\.org/);
    assert.match(decision.message, /this hook does nothing/);
    assert.match(decision.message, /nodejs\.org/);
  });

  test("errors when Node version is unknown and Bun is absent", () => {
    const decision = decideRuntime({ ...base, bunPath: null, nodeMajor: 0, distExists: false });
    assert.equal(decision.kind, "error");
    assert.match(decision.message, new RegExp(`Node\\.js ${MIN_NODE_MAJOR}\\+`));
  });
});

describe("Bun/Node dual-runtime parity", () => {
  const fixture = join(import.meta.dirname, "fixtures", "tlc-exec-echo.mjs");

  test("Bun and Node produce byte-identical stdout for the same script", () => {
    const bunPath = findBunOnPath(process.env);
    if (!bunPath) {
      console.log("tlc-exec.test: bun not found on PATH — skipping dual-runtime parity check");
      return;
    }
    const viaBun = spawnSync(bunPath, ["run", fixture], { encoding: "utf8" });
    const viaNode = spawnSync(process.execPath, [fixture], { encoding: "utf8" });
    assert.equal(viaBun.status, 0);
    assert.equal(viaNode.status, 0);
    assert.equal(viaBun.stdout, viaNode.stdout);
  });
});

describe("resolveHarnessHome — install path preference", () => {
  const resolver = (mapping: Record<string, string>) => (path: string) => {
    const resolved = mapping[path];
    if (!resolved) {
      throw new Error(`ENOENT: ${path}`);
    }
    return resolved;
  };

  test("an explicit TLC_HOME wins over anything derived", () => {
    assert.equal(
      resolveHarnessHome("/ignored", { TLC_HOME: "/explicit" }, "/x/bin/tlc-exec.mjs"),
      "/explicit",
    );
  });

  // hazard: both wrappers collapse the symlink before invoking, so the candidate names the checkout. Every
  // shim hook written from this value pointed at a directory that exists only on the machine that ran init.
  // hazard: the fixtures have to be built with join, since join is what the code calls. POSIX literals
  // passed everywhere except Windows, where the separator differs and nothing matched.
  test("the conventional install path wins when it resolves to the same runtime", () => {
    const fakeHome = join("/fake", "home"); // leak-gate-allow
    const conventional = join(fakeHome, ".tlc", "harness");
    const checkout = join("/repo", "checkout");
    const home = resolveHarnessHome("/ignored", {}, join(checkout, "bin", "tlc-exec.mjs"), {
      realpath: resolver({ [conventional]: checkout, [checkout]: checkout }),
      home: () => fakeHome,
    });
    assert.equal(home, conventional);
  });

  test("a deliberately relocated install is left alone", () => {
    const fakeHome = join("/fake", "home"); // leak-gate-allow
    const elsewhere = join("/other", "place");
    const home = resolveHarnessHome("/ignored", {}, join(elsewhere, "bin", "tlc-exec.mjs"), {
      realpath: resolver({
        [join(fakeHome, ".tlc", "harness")]: join("/somewhere", "else"),
        [elsewhere]: elsewhere,
      }),
      home: () => fakeHome,
    });
    assert.equal(home, elsewhere);
  });

  test("an absent conventional path falls back to the candidate instead of throwing", () => {
    const elsewhere = join("/other", "place");
    const home = resolveHarnessHome("/ignored", {}, join(elsewhere, "bin", "tlc-exec.mjs"), {
      realpath: resolver({ [elsewhere]: elsewhere }),
      home: () => join("/fake", "home"), // leak-gate-allow
    });
    assert.equal(home, elsewhere);
  });

  test("binDir is used when the invocation is not the launcher itself", () => {
    const binDir = join("/only", "bin");
    const home = resolveHarnessHome(binDir, {}, undefined, {
      realpath: resolver({ [join("/only")]: join("/only") }),
      home: () => join("/fake", "home"), // leak-gate-allow
    });
    assert.equal(home, join(binDir, ".."));
  });
});

describe("an npm-installed copy defers to the installed runtime", () => {
  const deps = (home: string, present: string[]) => ({
    realpath: (path: string) => path,
    home: () => home,
    exists: (path: string) => present.includes(path),
  });

  test("a packaged copy uses the conventional home once a runtime is installed there", () => {
    const home = join("/users", "me");
    const conventional = join(home, ".tlc", "harness");
    const pkgBin = join("/usr", "lib", "node_modules", "@tech-leads-club", "harness-toolkit", "bin");
    const resolved = resolveHarnessHome(
      pkgBin,
      {},
      join(pkgBin, "tlc-exec.mjs"),
      deps(home, [join(conventional, "bin", "tlc-exec.mjs")]),
    );
    assert.equal(resolved, conventional);
  });

  // why: the package has to be able to run itself in order to create that home in the first place.
  test("before anything is installed there the package runs from itself", () => {
    const home = join("/users", "me");
    const pkgBin = join("/usr", "lib", "node_modules", "@tech-leads-club", "harness-toolkit", "bin");
    const resolved = resolveHarnessHome(pkgBin, {}, join(pkgBin, "tlc-exec.mjs"), deps(home, []));
    assert.equal(resolved, join(pkgBin, ".."));
  });

  test("a clone that is not under node_modules is never redirected", () => {
    const home = join("/users", "me");
    const conventional = join(home, ".tlc", "harness");
    const cloneBin = join("/users", "me", "repos", "harness-toolkit", "bin");
    const resolved = resolveHarnessHome(
      cloneBin,
      {},
      join(cloneBin, "tlc-exec.mjs"),
      deps(home, [join(conventional, "bin", "tlc-exec.mjs")]),
    );
    assert.equal(resolved, join(cloneBin, ".."));
  });

  test("TLC_HOME still wins over everything", () => {
    const pkgBin = join("/usr", "lib", "node_modules", "@tech-leads-club", "harness-toolkit", "bin");
    const resolved = resolveHarnessHome(
      pkgBin,
      { TLC_HOME: "/explicit" },
      join(pkgBin, "tlc-exec.mjs"),
      deps(join("/users", "me"), [join("/users", "me", ".tlc", "harness", "bin", "tlc-exec.mjs")]),
    );
    assert.equal(resolved, "/explicit");
  });

  test("isPackagedCopy matches a path segment, not a substring", () => {
    assert.equal(isPackagedCopy(join("/a", "node_modules", "pkg")), true);
    assert.equal(isPackagedCopy(join("/a", "my_node_modules_backup", "pkg")), false);
    assert.equal(isPackagedCopy(join("/a", "repos", "harness-toolkit")), false);
  });
});

describe("the runtime cache never writes into the package", () => {
  test("a packaged home is not cached, and the record is still returned", () => {
    const root = newRoot();
    const pkg = join(root, "node_modules", "@tech-leads-club", "harness-toolkit");
    mkdirSync(pkg, { recursive: true });
    const record = writeRuntimeCache(pkg, "/usr/bin/bun");
    assert.equal(record.bunPath, "/usr/bin/bun");
    assert.equal(existsSync(join(pkg, "state", "runtime-cache.json")), false);
  });

  // hazard: the first version pointed this at a path under /proc, where mkdirSync hangs rather than failing on
  // WSL2 — the suite stopped at module load with no failing test to name. A file standing where a directory has
  // to go is the unwritable case that actually fails fast.
  test("an unwritable home degrades to no cache instead of throwing", () => {
    const root = newRoot();
    mkdirSync(root, { recursive: true });
    const blocked = join(root, "not-a-dir");
    writeFileSync(blocked, "");
    const record = writeRuntimeCache(blocked, null);
    assert.equal(record.bunPath, null);
  });

  test("an ordinary home is still cached", () => {
    const root = newRoot();
    mkdirSync(root, { recursive: true });
    writeRuntimeCache(root, "/usr/bin/bun");
    assert.equal(existsSync(join(root, "state", "runtime-cache.json")), true);
  });
});

/**
 * hazard: a launcher that could not run emitted nothing on stdout and exit 1. Claude reads that as a non-blocking
 * error; Cursor's `beforeShellExecution` contract does not describe it. Measured on an operator's machine: every
 * tool in an unrelated session was blocked while the runtime was mid-edit, and the only way out was editing
 * provider hooks by hand ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * invariant: a harness that cannot run was protecting nothing, so it must not be what stops the turn — but a
 * *command* that cannot run has to fail, or the operator and CI lose the signal.
 */
describe("a runtime that cannot run", () => {
  const broken = join(tmpdir(), "tlc-exec-no-runtime-does-not-exist");

  function launch(entry: string): { stdout: string; status: number | null } {
    const result = spawnSync(process.execPath, [launcher, entry], {
      encoding: "utf8",
      input: "",
      env: { ...process.env, TLC_HOME: broken },
    });
    return { stdout: result.stdout ?? "", status: result.status };
  }

  test("AC1 a hook carries on, in the shape both hosts read as no opinion", () => {
    const result = launch("tool-before");

    assert.equal(result.stdout.trim(), "{}");
    assert.equal(result.status, 0);
  });

  test("AC2 and the diagnosis still reaches the operator on stderr", () => {
    const result = spawnSync(process.execPath, [launcher, "tool-before"], {
      encoding: "utf8",
      input: "",
      env: { ...process.env, TLC_HOME: broken },
    });

    assert.match(result.stderr ?? "", /tlc:/);
  });

  /** AC5 — the opposite duty. A failing `doctor` that exits 0 is a green light nobody earned. */
  test("AC5 a command still fails loudly", () => {
    const result = launch("doctor");

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });

  test("AC5 every hook entry carries on and every other entry does not", () => {
    for (const entry of ["stop", "session-start", "subagent-stop"]) {
      assert.equal(launch(entry).status, 0, entry);
    }
    for (const entry of ["install-runtime", "lessons-cli", "tlc-cli"]) {
      assert.notEqual(launch(entry).status, 0, entry);
    }
  });

  /**
   * AC6 — the list cannot drift. A hook missing from it fails closed, which is the direction that blocks a working
   * machine, so the gate compares it against the entrypoints that actually run as programs.
   */
  test("AC6 the hook list is exactly the entrypoints that run as programs", () => {
    const dir = join(repoRoot, "src", "entrypoints");
    const programs = readdirSync(dir)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => readFileSync(join(dir, file), "utf8").includes("import.meta.main"))
      .map((file) => file.replace(/\.ts$/, ""))
      // why excluded: the project shim is not dispatched through this launcher — it re-dispatches to it, and
      // carries its own carry-on path for the same reason.
      .filter((entry) => entry !== "shim")
      .sort();

    assert.deepEqual([...HOOK_ENTRIES].sort(), programs);
  });
});

/**
 * The launcher half of the provider-hint channel: a wiring entry writes `--provider <name>` ahead of the handler,
 * and it has to leave the argument list before anything reads the handler out of a position.
 */
describe("takeProviderHint", () => {
  test("lifts --provider out and leaves the handler first in the rest", () => {
    const { hint, rest } = takeProviderHint(["--provider", "vscode", "tool-before"]);
    assert.equal(hint, "vscode");
    assert.deepEqual(rest, ["tool-before"]);
  });

  test("accepts the --provider=<name> spelling", () => {
    const { hint, rest } = takeProviderHint(["--provider=codex", "stop", "--json"]);
    assert.equal(hint, "codex");
    assert.deepEqual(rest, ["stop", "--json"]);
  });

  // why: a wiring entry could place it after the handler, and the flag must not then be forwarded as a handler
  // argument — an entrypoint reading its own argv would see a flag it does not know.
  test("removes the flag wherever it appears, never forwarding it", () => {
    const { hint, rest } = takeProviderHint(["session-start", "--provider", "opencode"]);
    assert.equal(hint, "opencode");
    assert.deepEqual(rest, ["session-start"]);
    assert.equal(rest.includes("--provider"), false);
  });

  test("no flag means no hint, and the arguments are untouched", () => {
    const { hint, rest } = takeProviderHint(["tool-before", "extra"]);
    assert.equal(hint, null);
    assert.deepEqual(rest, ["tool-before", "extra"]);
  });

  // hazard: a trailing --provider with no value must not become an empty hint. An empty hint names no provider and
  // would refuse every payload on that host — a whole host silently unsteered from one malformed wiring line.
  test("a valueless --provider yields no hint rather than an empty one", () => {
    assert.equal(takeProviderHint(["--provider"]).hint, null);
    assert.equal(takeProviderHint(["--provider", "--json", "stop"]).hint, null);
    assert.equal(takeProviderHint(["--provider="]).hint, null);
    assert.deepEqual(takeProviderHint(["--provider", "--json", "stop"]).rest, ["--json", "stop"]);
  });
});

describe("childEnv", () => {
  const HOME = join("/opt", "tlc-home");

  test("a hint becomes TLC_PROVIDER_HINT in the child environment", () => {
    const env = childEnv(HOME, "/origin", "vscode", {});
    assert.equal(env.TLC_PROVIDER_HINT, "vscode");
    assert.equal(env.TLC_HOME, HOME);
    assert.equal(env.TLC_ORIGIN, "/origin");
  });

  test("no hint leaves TLC_PROVIDER_HINT unset", () => {
    assert.equal(childEnv(HOME, "/origin", null, {}).TLC_PROVIDER_HINT, undefined);
  });

  // hazard: an inherited hint surviving into an un-hinted hook would short-circuit detection to whatever the last
  // hinted host was, and look like it worked.
  test("an inherited hint is cleared when this invocation has none", () => {
    const env = childEnv(HOME, "/origin", null, { TLC_PROVIDER_HINT: "codex" });
    assert.equal(env.TLC_PROVIDER_HINT, undefined);
  });

  test("a hint on this invocation overrides an inherited one", () => {
    const env = childEnv(HOME, "/origin", "cursor", { TLC_PROVIDER_HINT: "codex" });
    assert.equal(env.TLC_PROVIDER_HINT, "cursor");
  });
});

/**
 * The composition, not the pieces.
 *
 * hazard: `takeProviderHint` and `childEnv` were each unit-tested and `main()` could still drop the hint on the
 * floor between them — dropping the argument at the `run(...)` call site, or never calling the parser at all, both
 * left the whole suite green. The launcher half of the hint channel could be disconnected and ship. Only spawning
 * the real launcher and reading what the child actually received defends that seam.
 *
 * why a `dist/` stub and not a real entrypoint: `decideRuntime` prefers `dist/<entry>.mjs` when the home has no
 * matching source, so a throwaway home is enough. Adding an entrypoint under `src/entrypoints/` instead would make
 * the hook-list gate count it as a hook.
 */
describe("the launcher carries the hint into the child process", () => {
  function probeHome(): string {
    const home = newRoot();
    mkdirSync(join(home, "dist"), { recursive: true });
    writeFileSync(
      join(home, "dist", "hint-probe.mjs"),
      "process.stdout.write(JSON.stringify({" +
        " hint: process.env.TLC_PROVIDER_HINT ?? null," +
        " argv: process.argv.slice(2) }));\n",
    );
    return home;
  }

  function launch(home: string, args: string[], inherited?: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, TLC_HOME: home };
    if (inherited === undefined) {
      delete env.TLC_PROVIDER_HINT;
    } else {
      env.TLC_PROVIDER_HINT = inherited;
    }
    const result = spawnSync(process.execPath, [join(repoRoot, "bin", "tlc-exec.mjs"), ...args], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, `launcher exited ${result.status}: ${result.stderr}`);
    return JSON.parse(result.stdout) as { hint: string | null; argv: string[] };
  }

  test("--provider reaches the child as TLC_PROVIDER_HINT and never reaches its argv", () => {
    const seen = launch(probeHome(), ["--provider", "vscode", "hint-probe", "extra"]);
    assert.equal(seen.hint, "vscode");
    assert.deepEqual(seen.argv, ["extra"]);
  });

  test("the --provider=<name> spelling arrives the same way", () => {
    assert.equal(launch(probeHome(), ["--provider=codex", "hint-probe"]).hint, "codex");
  });

  test("without --provider the child sees no hint at all", () => {
    const seen = launch(probeHome(), ["hint-probe"]);
    assert.equal(seen.hint, null);
    assert.deepEqual(seen.argv, []);
  });

  // hazard: the inherited-hint leak, proven end to end rather than at the helper.
  test("an inherited hint does not survive an un-hinted launch", () => {
    assert.equal(launch(probeHome(), ["hint-probe"], "codex").hint, null);
  });

  test("this invocation's hint beats an inherited one", () => {
    assert.equal(launch(probeHome(), ["--provider", "cursor", "hint-probe"], "codex").hint, "cursor");
  });
});
