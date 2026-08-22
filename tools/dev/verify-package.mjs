/**
 * Packs the publishable tarball, installs it into a clean room, and drives the installed command.
 *
 * why this and not the suite: every test here runs against the working tree, which is not the package. Three
 * install defects reached operators because of that gap — 0.3.0 installed nothing at all, 0.3.2 shipped bundles
 * where every entry answered as the CLI, and 0.4.0 left `tlc` off `PATH` entirely. Each was found by a person on
 * their own machine, after publish. The published practice is to pack, install the tarball the way `npx` would, and
 * drive the real binary ([/decisions/ad-102.md](/decisions/ad-102.md)).
 *
 * why one room on every platform instead of a container on one: the container was the stronger clean room and it
 * only exists on Linux, so the artefact that reaches operators was installed and driven on Linux and nowhere else —
 * while every defect that reached them was an install defect, and install is the most platform-shaped code in the
 * package (`~/.local/bin` against a `.cmd` shim, `PATH` against `PATHEXT`, a link against a copy). On a CI runner
 * the whole machine is already throwaway, so the container's extra isolation bought little; a third platform buys a
 * class of defect nothing else here can see ([/decisions/ad-103.md](/decisions/ad-103.md)).
 *
 * invariant: no shell composition. Each step is its own process with its own exit status, so there is no `&&` chain
 * for a trailing `||` to swallow and no POSIX-only script for Windows to choke on. A shell is still what resolves
 * `npm` and `tlc` from `PATH`, which is all `shell: true` per step is for.
 *
 * invariant: this is a release step, not a gate step. It needs the network to resolve dependencies, so it does not
 * belong in the loop a contributor runs on every change.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { PROJECT_SCOPED_ENV, REDIRECTED_ENV, RUNTIME_SCOPED_ENV } from "../test-env.names.mjs";

function fail(message) {
  console.error(`verify-package: ${message}`);
  process.exit(1);
}

/** why the manifest and not a hard-coded name: the tarball name carries the version, and the version moves. */
function packageIdentity() {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  return { name: manifest.name, version: manifest.version };
}

/**
 * invariant: the file list is asserted before anything is installed. A tarball missing `bin/` installs a command
 * that cannot run, and that is cheaper to catch here than after the registry has it for good.
 *
 * why npm's own list and not `tar -tzf`: `tar` is not a command on Windows, and what npm prints is what npm packed
 * rather than a second reading of it.
 */
export function assertPayload(entries) {
  const required = [
    "package.json",
    "bin/tlc",
    "bin/tlc.mjs",
    "bin/tlc-exec.mjs",
    "dist/tool-before.mjs",
    "skills/harness-init/SKILL.md",
  ];
  const missing = required.filter((path) => !entries.includes(path));
  if (missing.length > 0) {
    fail(`the tarball is missing what the runtime needs: ${missing.join(", ")}`);
  }
  // hazard: `tools/dev` holds the checks that validate *this* repository, and with Bun present the launcher
  // resolves an entry straight from source — so shipping them would put runnable repo-only commands on a user's
  // machine ([/decisions/ad-068.md](/decisions/ad-068.md)).
  const leaked = entries.filter((path) => path.startsWith("tools/dev/") || path.includes("/__test__/"));
  if (leaked.length > 0) {
    fail(`the tarball ships what it must not: ${leaked.slice(0, 5).join(", ")}`);
  }
  console.log(`verify-package: payload ok (${entries.length} entries)`);
  /**
   * why the entries are returned and used: an independent review deleted the call to this function and every test
   * stayed green, because the assertions read the script's *source* for the strings it checks. Handing the caller a
   * value it needs makes removing the call a runtime error rather than a convention nobody enforces
   * ([/decisions/ad-102.md](/decisions/ad-102.md)).
   */
  return entries;
}

/**
 * The clean room's steps, as data.
 *
 * why a list of records and not one script: an independent review deleted the `tlc harness doctor` line and the
 * test stayed green, because it asserted the script's source *contained* that text — and the version check on the
 * next line contained it too. A list can be asserted element by element
 * ([/decisions/ad-102.md](/decisions/ad-102.md)).
 *
 * why `expect` is a field rather than a `grep` step: `grep` is not a command on Windows, and a pipeline's exit
 * status was the other half of the swallowed-failure defect. The runner reads the captured output instead.
 */
export function probeSteps(tarball, version) {
  return [
    { label: "the tarball installs globally, the way npx would", command: `npm i -g "${tarball}" --silent` },
    // why version first: it is the one command that fails loudly when the shim exists but the runtime does not.
    { label: "the installed command answers", command: "tlc harness version" },
    { label: "a fresh install completes", command: "tlc harness install" },
    // why doctor: it is the reading an operator is told to trust, so it has to survive a fresh install with no
    // project, no config and no prior state. The version is read back out of it because the tarball says one thing
    // and the runtime an operator reads is what matters — a shim resolving an older runtime reports the older one.
    {
      label: "doctor survives a fresh install and reports this version",
      command: "tlc harness doctor",
      expect: `harness version — ${version}`,
    },
  ];
}

/**
 * npm's own report of what it packed, out of a stream that is not only that report.
 *
 * hazard: `prepack` runs the bundler, so `JSON.parse` on the whole stdout dies on the letter `l` of `tlc-build`.
 * `--silent` does not help: it silences npm, not the script npm runs. Nor does scanning for the first `[`, because
 * the bundler colours its output and an ANSI escape *starts* with one — which is the second thing this function was
 * written wrong as.
 *
 * why from the end: npm's report is the last document on the stream. Both shapes it has used are handled — an array
 * of reports, and an object keyed by package name ([/decisions/ad-103.md](/decisions/ad-103.md)).
 */
export function parsePackReport(stdout) {
  const lines = stdout.split("\n");
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    const opener = (lines[start] ?? "").trim();
    if (opener !== "[" && opener !== "{") {
      continue;
    }
    try {
      return Object.values(JSON.parse(lines.slice(start).join("\n")))[0] ?? null;
    } catch {
      // why swallowed: a line that merely looks like the start of the report is not one, and the next candidate
      // further up is the answer. Throwing here would report a parse error about the wrong text.
    }
  }
  return null;
}

/**
 * Runs the steps in order and stops at the first failure.
 *
 * hazard: these used to be joined with ` && ` and ended in `|| echo "<message>"`. `&&` and `||` share precedence,
 * so any failure anywhere in the chain fell into the `||` and the compound command exited 0 — which made the status
 * check unreachable, hid the clean room's stderr entirely, and reported every possible failure as the same wrong
 * message. Proven: `sh -c 'true && false && echo x | grep -q y || echo swallowed'` exits 0. One process per step
 * removes the composition that made it possible ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
export function runSteps(steps, options) {
  for (const [index, step] of steps.entries()) {
    const result = spawnSync(step.command, { ...options, shell: true, encoding: "utf8" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0) {
      return { ok: false, step, index, output, reason: `exit ${result.status ?? "signal"}` };
    }
    if (step.expect !== undefined && !output.includes(step.expect)) {
      return { ok: false, step, index, output, reason: `output does not contain ${JSON.stringify(step.expect)}` };
    }
    console.log(`verify-package: ok — ${step.label}`);
  }
  return { ok: true };
}

/**
 * The two the suite redirects and this probe must leave absent.
 *
 * hazard: pointing them at the throwaway made the launcher look for the runtime *there* — an empty directory,
 * because `install` has not run yet at that step — and the probe died with "dist/tlc-cli.mjs is missing" on all
 * three platforms. The suite redirects them because it runs this code in-process against fake paths; an installed
 * command has to resolve its own runtime out of the package it was installed from, and any value here answers that
 * question for it ([/decisions/ad-103.md](/decisions/ad-103.md)).
 */
const UNSET_HERE = ["TLC_HOME", "TLC_INSTALL_DEST"];

/**
 * The child's environment: every name that says *where* pointed at the throwaway, and every name that says *which
 * project* or *which runtime source* removed.
 *
 * hazard: this used to be `{...process.env, HOME, USERPROFILE}`. `tlc harness install` writes provider hooks into
 * whatever `CLAUDE_CONFIG_DIR` and `CURSOR_CONFIG_DIR` resolve to, and this script inherited them from the shell —
 * so a run inside an agent session rewrote the operator's real `settings.json` to point at a temp directory this
 * function then deleted, and every hook on that machine failed to load. The suite has had a list for exactly this
 * since two defects of the same shape landed in one afternoon; the release script built its environment by hand and
 * used none of it ([/decisions/ad-102.md](/decisions/ad-102.md), [/decisions/ad-103.md](/decisions/ad-103.md)).
 *
 * why both `<prefix>` and `<prefix>/bin` are on PATH: npm puts the shim directly in the prefix on Windows and in
 * `bin/` everywhere else. Naming one of them is how a check passes on the platform it was written on and fails on
 * the other.
 */
export function probeEnv(base, prefix, home) {
  const env = { ...base };
  for (const name of [...PROJECT_SCOPED_ENV, ...RUNTIME_SCOPED_ENV, ...UNSET_HERE]) {
    delete env[name];
  }
  const destinations = {
    HOME: home,
    USERPROFILE: home,
    TLC_BIN_DIR: join(home, ".local", "bin"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CURSOR_CONFIG_DIR: join(home, ".cursor"),
  };
  for (const name of REDIRECTED_ENV) {
    if (UNSET_HERE.includes(name)) {
      continue;
    }
    // invariant: every declared destination gets a value here. A name added to the list and not to the map would
    // otherwise stay pointed at the operator's own path, which is the defect above.
    env[name] = destinations[name] ?? home;
  }
  env.npm_config_prefix = prefix;
  env.PATH = [prefix, join(prefix, "bin"), base.PATH ?? ""].join(delimiter);
  return env;
}

/**
 * why a prefix and not a real `npm i -g`: a real global install would replace the operator's own command, which is
 * exactly the class of defect this script exists to catch. The prefix keeps it to a throwaway directory.
 */
function inPrefix(tarball, version) {
  const prefix = mkdtempSync(join(tmpdir(), "tlc-verify-prefix-"));
  const home = mkdtempSync(join(tmpdir(), "tlc-verify-home-"));
  try {
    const result = runSteps(probeSteps(tarball, version), {
      cwd: process.cwd(),
      env: probeEnv(process.env, prefix, home),
    });
    return { ...result, room: `npm prefix ${prefix}, home ${home}` };
  } finally {
    rmSync(prefix, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * `--from <name@version>` drives the *published* version instead of a local tarball.
 *
 * why after the publish as well as before: everything before it reads a tarball this repository produced. What an
 * operator installs is what the registry serves, and the two have differed — 0.3.2 shipped bundles where every
 * entry answered as the CLI. This is the only step that can see that, and it can only see it too late: there is no
 * rollback, so the value is a red run within minutes instead of a person on their own machine days later
 * ([/decisions/ad-103.md](/decisions/ad-103.md)).
 *
 * hazard: the separator was found with `lastIndexOf("@")`, which on `@scope/pkg` finds the `@` that starts the
 * scope — so a scoped name with no version read as version `scope/pkg` and walked straight past the guard written
 * to stop it. That is this package's own shape. The search starts at index 1 now, where a separator can actually
 * be ([/decisions/ad-103.md](/decisions/ad-103.md)).
 */
export function registrySpec(argv) {
  const at = argv.indexOf("--from");
  const spec = at < 0 ? null : (argv[at + 1] ?? null);
  if (spec === null) {
    return null;
  }
  const separator = spec.indexOf("@", 1);
  const version = separator < 0 ? "" : spec.slice(separator + 1);
  if (version === "") {
    fail(`--from needs <name@version>, got ${spec}`);
  }
  return { spec, version };
}

/**
 * why a bounded retry and not a fixed sleep: a registry is eventually consistent across its CDN, so the version can
 * be seconds behind the publish that created it. A failure here has to mean the package is broken, not that it is
 * new — and a sleep long enough to be safe is a sleep every green run pays.
 *
 * invariant: only the install step is retried, and only for as long as the caller allows. Anything after the install
 * succeeded is a real failure and returns immediately.
 *
 * hazard: an unreadable value used to become 0 in silence, which makes the flag in the workflow decorative — the
 * exact failure its own test docstring names. Absent is 0 and present-but-unreadable is fatal, the way `--from`
 * already behaved ([/decisions/ad-103.md](/decisions/ad-103.md)).
 */
export function attempts(argv) {
  const at = argv.indexOf("--retries");
  if (at < 0) {
    return 0;
  }
  const given = argv[at + 1] ?? "";
  const parsed = Number.parseInt(given, 10);
  if (!/^\d+$/.test(given.trim()) || !Number.isFinite(parsed)) {
    fail(`--retries needs a whole number, got ${JSON.stringify(given)}`);
  }
  return parsed;
}

function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/**
 * hazard: this module's main flow ran at module scope, so importing it to test the steps executed `npm pack` and the
 * whole probe. It passed here and failed the macOS leg of CI with a file-level error at line 1 — the module, not a
 * test. This repository already has the rule: no library module self-executes
 * ([/decisions/ad-098.md](/decisions/ad-098.md), [/decisions/ad-102.md](/decisions/ad-102.md)).
 */
if (import.meta.main) {
  const published = registrySpec(process.argv);
  if (published !== null) {
    const retries = attempts(process.argv);
    let probe = inPrefix(published.spec, published.version);
    // invariant: only step 0 — resolving and installing the spec — is retried. A runtime that installed and then
    // failed to answer is broken, and waiting will not change that.
    for (let attempt = 1; attempt <= retries && !probe.ok && probe.index === 0; attempt += 1) {
      console.log(`verify-package: ${published.spec} not installable yet — attempt ${attempt} of ${retries}`);
      sleepSeconds(10);
      probe = inPrefix(published.spec, published.version);
    }
    console.log(`verify-package: clean room = ${probe.room}`);
    if (!probe.ok) {
      process.stderr.write(probe.output ?? "");
      fail(`${probe.step.label} — ${probe.reason}`);
    }
    console.log(`verify-package: ok — ${published.spec} installs from the registry and answers on ${process.platform}`);
    process.exit(0);
  }

  const { version } = packageIdentity();
  // why `--json`: it writes the tarball and prints what went into it, so the payload assertion reads npm's own
  // answer instead of shelling out to a second tool Windows does not have.
  const packed = spawnSync("npm", ["pack", "--json"], { encoding: "utf8", shell: true });
  if (packed.status !== 0) {
    fail(`npm pack failed: ${packed.stderr}`);
  }
  const report = parsePackReport(packed.stdout ?? "");
  const tarball = resolve(report?.filename ?? "");
  if (report === null || !existsSync(tarball)) {
    fail(`npm pack reported ${report?.filename}, which is not there`);
  }

  try {
    const entries = assertPayload((report.files ?? []).map((file) => file.path));
    const probe = inPrefix(tarball, version);
    console.log(`verify-package: clean room = ${probe.room}, ${entries.length} entries`);
    if (!probe.ok) {
      // invariant: the clean room's own output, which is the only place the real reason exists.
      process.stderr.write(probe.output ?? "");
      fail(`${probe.step.label} — ${probe.reason}`);
    }
    console.log(`verify-package: ok — ${version} installs and answers on ${process.platform}`);
  } finally {
    rmSync(tarball, { force: true });
  }
}
