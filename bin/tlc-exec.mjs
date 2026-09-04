#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIN_NODE_MAJOR = 24;

export function conventionalHarnessHome(home = homedir()) {
  return join(home, ".tlc", "harness");
}

function samePath(left, right, resolve) {
  try {
    return resolve(left) === resolve(right);
  } catch {
    return false;
  }
}

// hazard: ESM resolves import.meta.url to the realpath, and the bash wrappers walk readlink before
// invoking, so both binDir and argv[1] can name the checkout rather than the install path. Anything derived
// from this value is written into hook files and compared by doctor, so the checkout leaking in here made
// generated shims point at a directory that only exists on the machine that ran init.
// invariant: the conventional path wins only when it resolves to the same runtime — verified, never assumed,
// so a deliberately relocated install is left alone.
/**
 * why: an npm-installed copy lives under a directory npm replaces wholesale on update, so anything the runtime
 * writes there is deleted by the next `npm i -g` — measured on the packed tarball, which put `runtime-cache.json`
 * inside the package on its first run, where the global lesson tier and the cross-repository spool would follow.
 *
 * invariant: the installed runtime under the conventional home wins, and the npm copy is only the delivery
 * vehicle plus the CLI shim that reaches it. Hooks already name the conventional path directly, so the hot path
 * never asks this question.
 */
export function isPackagedCopy(candidate) {
  return candidate.split(/[/\\]/).includes("node_modules");
}

export function resolveHarnessHome(
  binDir,
  env = process.env,
  invoked = process.argv[1],
  deps = { realpath: realpathSync, home: homedir, exists: existsSync },
) {
  const fromEnv = env.TLC_HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const candidate = invoked?.endsWith("tlc-exec.mjs") ? join(dirname(invoked), "..") : join(binDir, "..");
  const conventional = conventionalHarnessHome(deps.home());
  if (conventional !== candidate && samePath(conventional, candidate, deps.realpath)) {
    return conventional;
  }
  // invariant: only when that home actually holds a runtime. Before `tlc harness install` has ever run there is
  // nothing there, and the package has to be able to run itself in order to put it there.
  const exists = deps.exists ?? existsSync;
  if (isPackagedCopy(candidate) && exists(join(conventional, "bin", "tlc-exec.mjs"))) {
    return conventional;
  }
  return candidate;
}

/**
 * why a list and not a branch: the only difference between platforms is which of these names exists on disk, and
 * asking for both costs one extra `existsSync` per PATH entry. `bun.exe` never exists on Linux and `bun` never
 * shadows it on Windows ([/decisions/ad-097.md](/decisions/ad-097.md)).
 */
export const BUN_EXECUTABLE_NAMES = ["bun", "bun.exe"];

export function findBunOnPath(env = process.env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of BUN_EXECUTABLE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function runtimeCachePath(harnessHome) {
  return join(harnessHome, "state", "runtime-cache.json");
}

export function readRuntimeCache(harnessHome) {
  const cachePath = runtimeCachePath(harnessHome);
  if (!existsSync(cachePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    if (parsed && typeof parsed === "object" && "bunPath" in parsed) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * hazard: this used to write unconditionally. On the first run of an npm-installed copy the home is still the
 * package, so it dropped a cache file into global `node_modules` — harmless on a prefix you own, and `EACCES`
 * on one installed with sudo, which would crash the bootstrap before it could install anything. The cache is
 * derived, so failing to write it costs one PATH scan per invocation and nothing else.
 */
export function writeRuntimeCache(harnessHome, bunPath) {
  const record = { bunPath, checkedAt: new Date().toISOString() };
  if (isPackagedCopy(harnessHome)) {
    return record;
  }
  try {
    const cachePath = runtimeCachePath(harnessHome);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(record)}\n`);
  } catch {
    // why: an unwritable runtime home degrades to probing every time, which is correct and merely slower.
  }
  return record;
}

export function resolveBunPath(harnessHome, env = process.env) {
  const cached = readRuntimeCache(harnessHome);
  if (cached) {
    return cached.bunPath;
  }
  const found = findBunOnPath(env);
  writeRuntimeCache(harnessHome, found);
  return found;
}

export function entrySourceCandidates(harnessHome, entry) {
  return [
    entry === "tlc-cli" ? join(harnessHome, "bin", "tlc-cli.ts") : null,
    join(harnessHome, "src", "entrypoints", `${entry}.ts`),
    join(harnessHome, "src", `${entry}.ts`),
    join(harnessHome, "tools", `${entry}.ts`),
  ].filter((candidate) => candidate !== null);
}

export function resolveEntrySource(harnessHome, entry) {
  for (const candidate of entrySourceCandidates(harnessHome, entry)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The entries that answer a host hook, as opposed to the ones an operator runs.
 *
 * why the distinction: a hook that cannot run must not stand between the agent and its tools, and a command that
 * cannot run must fail loudly or the operator and CI lose the signal. Same launcher, opposite duties
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * invariant: this list is checked against `src/entrypoints/` by the gate, so an entrypoint added later cannot be
 * left out of it — a hook missing from here fails closed, which is the direction that blocks a working machine.
 */
export const HOOK_ENTRIES = new Set([
  "compact-before",
  "prompt-submit",
  "response-after",
  "session-end",
  "session-start",
  "stop",
  "subagent-start",
  "subagent-stop",
  "tool-after",
  "tool-before",
  "tool-failure",
]);

/**
 * No opinion, in the shape both hosts read as "carry on".
 *
 * why `{}` rather than nothing: measured against both providers' own renderers, an abstain is `{}` on stdout for
 * Cursor and empty for Claude, and `{}` satisfies both — Claude parses it as a verdict with no decision. A broken
 * runtime used to emit nothing at all with exit 1, which Claude treats as a non-blocking error and Cursor's
 * contract does not describe. A harness that cannot run was protecting nothing, so it must not be the thing that
 * stops the turn ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
function carryOn() {
  process.stdout.write("{}");
  process.exit(0);
}

export function decideRuntime({ harnessHome, entry, bunPath, nodeMajor, distExists, srcPath }) {
  const distPath = join(harnessHome, "dist", `${entry}.mjs`);
  if (bunPath && srcPath && distExists) {
    return { kind: "run", command: bunPath, args: ["run", srcPath] };
  }
  if (nodeMajor >= MIN_NODE_MAJOR && distExists) {
    return { kind: "run", command: process.execPath, args: [distPath] };
  }
  if (bunPath && srcPath) {
    return { kind: "run", command: bunPath, args: ["run", srcPath] };
  }
  if (nodeMajor >= MIN_NODE_MAJOR) {
    return {
      kind: "error",
      status: 1,
      message: [
        `tlc: Node ${process.version} found, but dist/${entry}.mjs is missing.`,
        `  Run: node ${join(harnessHome, "bin", "tlc-build.mjs")}`,
      ].join("\n"),
    };
  }
  if (nodeMajor > 0 && nodeMajor < MIN_NODE_MAJOR) {
    return {
      kind: "error",
      status: 1,
      message: [
        `tlc: no supported hook runtime (Node ${process.version}, Bun not found).`,
        "  Either install Bun:  curl -fsSL https://bun.sh/install | bash",
        `  or Node >= ${MIN_NODE_MAJOR}:     https://nodejs.org/`,
        "  Then reload the editor session. Until then this hook does nothing.",
      ].join("\n"),
    };
  }
  return {
    kind: "error",
    status: 127,
    message: [
      `tlc: need Node.js ${MIN_NODE_MAJOR}+ with dist/, or Bun as optional fallback.`,
      "  Install: https://nodejs.org/ (prefer 24 LTS or 26 Current)",
    ].join("\n"),
  };
}

/**
 * Lifts `--provider <name>` (or `--provider=<name>`) out of the argument list and returns it separately.
 *
 * why it is removed rather than passed through: a wiring entry writes it ahead of the handler, and `main` reads the
 * handler positionally. Left in place it would be read as the entry name, and every hook on that host would fail
 * with a usage error instead of running.
 *
 * hazard: a trailing `--provider` with no value is dropped and reported as no hint, not carried as the empty
 * string. An empty hint that reached resolution would name no provider and refuse every payload — a whole host
 * silently unsteered, from one malformed wiring line.
 */
export function takeProviderHint(argv) {
  const rest = [];
  let hint = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--provider") {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        hint = value;
        i += 1;
      }
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length);
      if (value !== "") {
        hint = value;
      }
      continue;
    }
    rest.push(arg);
  }
  return { hint, rest };
}

/**
 * The environment the entrypoint runs under.
 *
 * why: `TLC_ORIGIN` is where this copy physically lives, which is not `TLC_HOME` once an npm-installed shim is
 * driving the runtime installed under the conventional path. `tlc harness install` needs the former as its source
 * and the latter as its destination, and nothing else in the runtime reads it.
 *
 * why a function and not an inline object: it is the whole of what the launcher hands the child, and spawning a
 * process to read it back needs an entrypoint that exists only to be read — which the entrypoint gate would then
 * count as a hook.
 */
export function childEnv(harnessHome, origin, providerHint = null, env = process.env) {
  return {
    ...env,
    TLC_HOME: harnessHome,
    TLC_ORIGIN: origin,
    // hazard: derived once, by the outermost launcher, and inherited after that. `tlc harness install` reaches
    // the tool through the CLI, so the launcher runs twice — and the second one saw the `TLC_HOME` the first
    // one had just set, concluded the operator had chosen it, and installed the runtime on top of itself.
    // Measured against the packed tarball: "runtime already at <package> — nothing to copy".
    TLC_HOME_FROM_ENV: env.TLC_HOME_FROM_ENV ?? (env.TLC_HOME?.trim() ? "1" : "0"),
    // hazard: set only when the wiring asked for it, and an inherited one is cleared otherwise. Leaving a stale
    // `TLC_PROVIDER_HINT` in place would make an un-hinted hook resolve to whatever the last hinted one named,
    // skipping detection entirely — the worst version of this failure, because it looks like it works.
    ...(providerHint ? { TLC_PROVIDER_HINT: providerHint } : { TLC_PROVIDER_HINT: undefined }),
  };
}

function run(harnessHome, command, commandArgs, origin = harnessHome, entry = "", providerHint = null) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: childEnv(harnessHome, origin, providerHint),
    shell: false,
  });
  if (result.error) {
    console.error(`tlc: failed to start ${command}: ${result.error.message}`);
    if (HOOK_ENTRIES.has(entry)) {
      carryOn();
    }
    process.exit(127);
  }
  process.exit(result.status ?? 1);
}

export function main(argv = process.argv) {
  const binDir = dirname(fileURLToPath(import.meta.url));
  const harnessHome = resolveHarnessHome(binDir);

  // why before the entry is read: a wiring entry writes `--provider <name>` ahead of the handler, so the flag has
  // to leave the list before anything reads a position out of it.
  const { hint: providerHint, rest } = takeProviderHint(argv.slice(2));

  const entry = rest[0];
  if (!entry) {
    console.error("usage: tlc-exec [--provider <name>] <entry> [args...]");
    console.error("  entry: session-start | tool-before | stop | doctor | ...");
    process.exit(2);
  }
  const args = rest.slice(1);

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const distExists = existsSync(join(harnessHome, "dist", `${entry}.mjs`));
  const srcPath = resolveEntrySource(harnessHome, entry);
  const bunPath = resolveBunPath(harnessHome);

  const decision = decideRuntime({ harnessHome, entry, bunPath, nodeMajor, distExists, srcPath });
  if (decision.kind === "error") {
    // invariant: the diagnosis still reaches stderr either way. Failing open is not failing silently.
    console.error(decision.message);
    if (HOOK_ENTRIES.has(entry)) {
      carryOn();
    }
    process.exit(decision.status);
  }
  run(harnessHome, decision.command, [...decision.args, ...args], join(binDir, ".."), entry, providerHint);
}

if (import.meta.main) {
  main();
}
