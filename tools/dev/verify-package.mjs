/**
 * Packs the publishable tarball, installs it into a clean room, and drives the installed command.
 *
 * why this and not the suite: every test here runs against the working tree, which is not the package. Three
 * install defects reached operators because of that gap — 0.3.0 installed nothing at all, 0.3.2 shipped bundles
 * where every entry answered as the CLI, and 0.4.0 left `tlc` off `PATH` entirely. Each was found by a person on
 * their own machine, after publish. The published practice is to pack, install the tarball the way `npx` would, and
 * drive the real binary ([/decisions/ad-102.md](/decisions/ad-102.md)).
 *
 * why a container when one is available: it is the clean room for free — no ambient `node_modules`, no global
 * state, no `PATH` leakage, and no chance of touching the operator's own install. Without docker the same script
 * runs against a throwaway npm prefix, which covers packaging and the command's own behaviour but shares the host's
 * filesystem. The output says which of the two ran, because a weaker check reported as the stronger one is worse
 * than no check.
 *
 * invariant: this is a release step, not a gate step. It needs the network to resolve dependencies, so it does not
 * belong in the loop a contributor runs on every change.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NODE_IMAGE = "node:24-alpine";

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

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
 */
export function assertPayload(tarball) {
  const listed = run("tar", ["-tzf", tarball]);
  if (listed.status !== 0) {
    fail(`cannot read ${tarball}: ${listed.stderr}`);
  }
  const entries = listed.stdout.split("\n");
  const required = [
    "package/package.json",
    "package/bin/tlc",
    "package/bin/tlc.mjs",
    "package/bin/tlc-exec.mjs",
    "package/dist/tool-before.mjs",
    "package/skills/harness-init/SKILL.md",
  ];
  const missing = required.filter((path) => !entries.includes(path));
  if (missing.length > 0) {
    fail(`the tarball is missing what the runtime needs: ${missing.join(", ")}`);
  }
  // hazard: `tools/dev` holds the checks that validate *this* repository, and with Bun present the launcher
  // resolves an entry straight from source — so shipping them would put runnable repo-only commands on a user's
  // machine ([/decisions/ad-068.md](/decisions/ad-068.md)).
  const leaked = entries.filter((path) => path.startsWith("package/tools/dev/") || path.includes("/__test__/"));
  if (leaked.length > 0) {
    fail(`the tarball ships what it must not: ${leaked.slice(0, 5).join(", ")}`);
  }
  const kept = entries.filter(Boolean);
  console.log(`verify-package: payload ok (${kept.length} entries)`);
  /**
   * why the entries are returned and used: an independent review deleted the call to this function and every test
   * stayed green, because the assertions read the script's *source* for the strings it checks. Handing the caller a
   * value it needs makes removing the call a runtime error rather than a convention nobody enforces
   * ([/decisions/ad-102.md](/decisions/ad-102.md)).
   */
  return kept;
}

/**
 * The commands the clean room runs, as data.
 *
 * why a list and not a string: an independent review deleted the `tlc harness doctor` line and the test stayed
 * green, because it asserted the script's source *contained* that text — and the version check on the next line
 * contains it too. A list can be asserted element by element ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
export function probeCommands(tarball, version) {
  return [
    `npm i -g /work/${tarball} --silent`,
    // why version first: it is the one command that fails loudly when the shim exists but the runtime does not.
    "tlc harness version",
    "tlc harness install",
    // why doctor: it is the reading an operator is told to trust, so it has to survive a fresh install with no
    // project, no config and no prior state.
    "tlc harness doctor",
    // why the version is read back out of `doctor`: the tarball says one thing, and the runtime an operator reads
    // is what matters. A shim resolving an older runtime reports the older version.
    `tlc harness doctor | grep -q "harness version — ${version}"`,
  ];
}

/**
 * hazard: these were joined with ` && ` and ended in `|| echo "<message>"`. `&&` and `||` share precedence, so any
 * failure anywhere in the chain fell into the `||` and the compound command exited 0 — which made the status check
 * below unreachable, hid the clean room's stderr entirely, and reported every possible failure as the same wrong
 * message. Proven: `sh -c 'true && false && echo x | grep -q y || echo swallowed'` exits 0
 * ([/decisions/ad-102.md](/decisions/ad-102.md)).
 *
 * invariant: `set -e` and one command per line, so the first failure is the exit status and the reason reaches the
 * operator as itself.
 */
export function composeProbe(commands) {
  return ["set -e", ...commands].join("\n");
}

function inContainer(tarball, version) {
  const probe = run("docker", [
    "run",
    "--rm",
    "-v",
    `${process.cwd()}:/work:ro`,
    "-w",
    "/tmp",
    NODE_IMAGE,
    "sh",
    "-c",
    composeProbe(probeCommands(tarball, version)),
  ]);
  return { ...probe, room: `container (${NODE_IMAGE})` };
}

/**
 * why a prefix and not just `npm i -g`: a real global install would replace the operator's own command, which is
 * exactly the class of defect this script exists to catch. The prefix keeps it to a throwaway directory.
 */
function inPrefix(tarball, version) {
  const prefix = mkdtempSync(join(tmpdir(), "tlc-verify-prefix-"));
  try {
    const probe = run("sh", ["-c", composeProbe(probeCommands(tarball, version))], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        npm_config_prefix: prefix,
        PATH: `${join(prefix, "bin")}:${process.env.PATH ?? ""}`,
        HOME: mkdtempSync(join(tmpdir(), "tlc-verify-home-")),
      },
    });
    return { ...probe, room: `npm prefix ${prefix} (no container — weaker: shares the host filesystem)` };
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

function dockerAvailable() {
  return run("docker", ["info"], { stdio: "ignore" }).status === 0;
}

const { version } = packageIdentity();
const packed = run("npm", ["pack", "--silent"]);
if (packed.status !== 0) {
  fail(`npm pack failed: ${packed.stderr}`);
}
const tarball = packed.stdout.trim().split("\n").pop() ?? "";
if (!existsSync(tarball)) {
  fail(`npm pack reported ${tarball}, which is not there`);
}

try {
  const entries = assertPayload(tarball);
  const probe = dockerAvailable() ? inContainer(tarball, version) : inPrefix(tarball, version);
  console.log(`verify-package: clean room = ${probe.room}, ${entries.length} entries`);
  process.stdout.write(probe.stdout ?? "");
  if ((probe.status ?? 1) !== 0) {
    // invariant: the clean room's own stderr, which is the only place the real reason exists.
    process.stderr.write(probe.stderr ?? "");
    fail(`the installed command failed in the clean room (exit ${probe.status})`);
  }
  console.log(`verify-package: ok — ${version} installs and answers in a clean room`);
} finally {
  rmSync(tarball, { force: true });
}
