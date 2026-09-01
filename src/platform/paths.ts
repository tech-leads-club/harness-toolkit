import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

function harnessDir(root: string): string {
  return join(root, ".tlc", "harness");
}

/**
 * why: the path hooks name and the one the installer materialises into. It is deliberately not derived from where
 * the code happens to sit, because an npm-installed copy sits under a directory npm replaces
 * ([/decisions/ad-056.md](/decisions/ad-056.md)).
 */
export function conventionalRuntimeHome(): string {
  return join(homedir(), ".tlc", "harness");
}

// why: the env is a parameter so a caller can be tested. The first version read `process.env` unconditionally,
// which made every destination-resolution test assert against the machine it ran on rather than its input.
export function runtimeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TLC_HOME ?? conventionalRuntimeHome();
}

/**
 * invariant: `tlc-exec` always sets `TLC_HOME` in the child, so the child cannot tell an operator's choice from
 * the launcher's own resolution. This flag is that difference.
 */
export function runtimeHomeWasChosen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TLC_HOME_FROM_ENV === "1";
}

/**
 * Where this **machine's** operator data lives: the user-tier config, the global lesson tier, the global rules,
 * the price catalogue, the cross-repo spool.
 *
 * hazard: all of that used to resolve through `runtimeHome()`, which names where the *code* lives and moves with
 * the install. With two installs on one machine there were two "global" tiers, silently — and switching between
 * them looked like data loss. Measured on an operator's machine: a lesson saved with `--global` landed in a
 * checkout's state directory while the CLI printed "every product on this machine will read it", and a user-tier
 * config with a subagent allowlist stopped being read the moment the runtime home changed
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * why the flag rather than always the conventional path: an operator who exports `TLC_HOME` is choosing a home and
 * means it, and the test suite pins one for hermeticity. Only the launcher's own resolution — which marks itself
 * `TLC_HOME_FROM_ENV=0` — must not be allowed to invent a second machine.
 */
export function machineHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TLC_HOME_FROM_ENV === "0" ? conventionalRuntimeHome() : runtimeHome(env);
}

/** invariant: the one path install seeds and update never writes ([/decisions/ad-056.md](/decisions/ad-056.md)). */
export function machineConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(machineHome(env), "config.json");
}

export function runtimeStateDir(): string {
  return join(machineHome(), "state");
}

// why: one file for every repository on the machine. Per-repo state stays authoritative; this is the
// cross-repo view, which cannot exist under any single project's state directory.
export function runtimeSpoolPath(): string {
  return join(runtimeStateDir(), "obs-spool.jsonl");
}

/**
 * The project a command is being run in: the nearest directory at or above `from` that holds a harness directory.
 *
 * why upward discovery: it is what every tool an operator already knows does — `git` walks up for `.git`, npm and
 * cargo for their manifests, biome and eslint for their config. Anything else makes the operator's shell position
 * part of the interface. Measured before this existed: `tlc harness status` run from `src/` reported the project as
 * `src`, found no config there, fell back to the machine tier, and printed a posture the project had not set. Every
 * command had that shape, and `policy accept` was only where it hurt enough to notice
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * invariant: `null` when there is none, so a first `init` still resolves to the working directory rather than to
 * whichever ancestor happens to be a project.
 */
export function findProjectRoot(
  from: string,
  exists: (path: string) => boolean = existsSync,
  machine: string = machineHome(),
): string | null {
  let current = resolve(from);
  for (;;) {
    /**
     * hazard: the machine's runtime home has the exact shape of a project's harness directory, so the walk claimed
     * the home directory as a project. A repository under it that had never been initialised then resolved its root
     * to the home, and its "project config" *was* the machine config — the machine tier read as the project tier,
     * and every uninitialised repository's flags, presence and baselines landed in one shared state directory
     * ([/decisions/ad-101.md](/decisions/ad-101.md)).
     *
     * invariant: skipped rather than stopped on. An operator who relocated the runtime home elsewhere can have a
     * real project at that path, and then it is claimable again.
     */
    if (exists(harnessDir(current)) && harnessDir(current) !== machine) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function projectConfigPath(root: string): string {
  return join(harnessDir(root), "config.json");
}

export function projectStateDir(root: string): string {
  return join(harnessDir(root), "state");
}

export function flagsDir(root: string): string {
  return join(projectStateDir(root), "flags");
}

export function presenceDir(root: string): string {
  return join(projectStateDir(root), "presence");
}

export function loopsDir(root: string): string {
  return join(projectStateDir(root), "loops");
}

export function bootDir(root: string): string {
  return join(projectStateDir(root), "boot");
}

export function handoffSessionsDir(root: string): string {
  return join(projectStateDir(root), "handoff-sessions");
}

// why: inside the state directory on purpose — the baseline that proves the policy was not switched off
// inherits the same protection as the policy itself.
export function policyBaselineDir(root: string): string {
  return join(projectStateDir(root), "policy-baseline");
}

export function claudeConfigDir(): string {
  const custom = process.env.CLAUDE_CONFIG_DIR?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), ".claude");
}

export function cursorConfigDir(): string {
  const custom = process.env.CURSOR_CONFIG_DIR?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), ".cursor");
}

/**
 * The user-level hook documents, in the order the shim reads them.
 *
 * why: the project shim is told a handler and nothing else — it does not know which provider invoked it. So it
 * asks both: if any user-level document already runs this handler, a second run would be a duplicate. The cost of
 * that imprecision is under-running in a setup where one editor is installed globally and the other only in the
 * project, which is the safe direction — the alternative was running the handler twice, which is what actually
 * happened ([/decisions/ad-095.md](/decisions/ad-095.md)).
 *
 * invariant: both paths are resolved, never assumed. Either tool can relocate its config directory by env, and
 * this repository is itself installed under a relocated one.
 */
export function userSettingsPaths(): string[] {
  return [join(claudeConfigDir(), "settings.json"), join(cursorConfigDir(), "hooks.json")];
}

/**
 * The provider config directories, resolved. Each provider reads only its own skills directory, so this is the
 * list anything linking the init skill must walk.
 *
 * invariant: resolved, never assumed — either tool relocates its config directory by env, and this repository is
 * itself installed under a relocated one ([/decisions/ad-095.md](/decisions/ad-095.md)).
 */
export function providerConfigDirs(): string[] {
  return [cursorConfigDir(), claudeConfigDir()];
}

/**
 * Where the `tlc` command goes so a shell can find it.
 *
 * hazard: this lived only in `uninstall-runtime.ts`, which removed a launcher `install` never created. The command
 * came from npm's own shim instead — and that shim sits in the `bin` directory of whichever Node version npm ran
 * under, which leaves `PATH` the moment a version manager switches. Measured on an operator's machine: a
 * successful install followed immediately by `tlc: command not found`
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * invariant: one definition, so what install creates and what uninstall removes cannot drift apart.
 */
export function launcherBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TLC_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
}

/** why the extensionless wrapper: it is what a shell runs. The `.cmd` beside it is Windows's copy of the same. */
export function launcherNames(): readonly string[] {
  return ["tlc", "tlc.cmd"];
}

/**
 * The one place `PATH` is split.
 *
 * hazard: four implementations walked it — the CLI's executable finder, `doctor`'s, the launcher's Bun probe, and
 * a third added for the install check. Three of them were the same function with different extension lists
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
export function pathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
}

/**
 * why the extensions: on Windows a command is `tlc`, `tlc.cmd`, `tlc.exe`, `tlc.bat` or `tlc.ps1` depending on who
 * generated it, and npm's shim is a `.cmd`. Asking for all of them costs one `existsSync` per entry and removes the
 * only reason the two finders differed.
 */
export const EXECUTABLE_EXTENSIONS = ["", ".exe", ".cmd", ".bat", ".ps1"] as const;

export function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  exists = existsSync,
): string | null {
  for (const dir of pathEntries(env)) {
    for (const ext of EXECUTABLE_EXTENSIONS) {
      const candidate = join(dir, `${name}${ext}`);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Whether a shell would find something in this directory.
 *
 * why it matters at install time: a launcher nobody can reach is worse than none, because `doctor` then reports a
 * healthy link while the command still does not exist.
 */
export function isOnPath(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return pathEntries(env).some((entry) => resolve(entry) === resolve(dir));
}

/**
 * Whether two paths name the same directory, following links.
 *
 * why not `resolve` alone: `resolve` is lexical, so a runtime home that is a symlink to a checkout compares
 * unequal to the checkout and every guard built on it misses. That is how `install` came to delete the checkout it
 * pointed at ([/decisions/ad-100.md](/decisions/ad-100.md)).
 *
 * why the fallback: a destination that does not exist yet has no real path, and a first install is exactly that
 * case. Then the lexical answer is the only one there is, and it is right — nothing is there to alias.
 */
export function sameLocation(a: string, b: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a) === real(b);
}
