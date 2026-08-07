import { homedir } from "node:os";
import { join } from "node:path";

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
 * the launcher's own resolution. This flag is that difference, and only the installer needs it — everything else
 * wants the resolved home either way.
 */
export function runtimeHomeWasChosen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TLC_HOME_FROM_ENV === "1";
}

export function runtimeStateDir(): string {
  return join(runtimeHome(), "state");
}

// why: one file for every repository on the machine. Per-repo state stays authoritative; this is the
// cross-repo view, which cannot exist under any single project's state directory.
export function runtimeSpoolPath(): string {
  return join(runtimeStateDir(), "obs-spool.jsonl");
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
