import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flagsDir, machineConfigPath, projectConfigPath } from "../../platform/paths.ts";
import { lessonsSyncMode, resolveSyncMode, type SyncModeResolution } from "../lesson/lesson.sync.ts";
import { DEFAULTS } from "./policy.defaults.ts";
import { type PostureResolution, resolvePosture } from "./policy.posture.ts";
import type { PartialPolicy, Policy } from "./policy.types.ts";

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function deepMerge(base: Policy, patch: PartialPolicy): Policy {
  return {
    ...base,
    ...patch,
    grind: { ...base.grind, ...patch.grind },
    shipGate: { ...base.shipGate, ...patch.shipGate },
    subagents: { ...base.subagents, ...patch.subagents },
    docs: { ...base.docs, ...patch.docs },
    observe: { ...base.observe, ...patch.observe },
    comments: { ...base.comments, ...patch.comments },
    supplyChain: { ...base.supplyChain, ...patch.supplyChain },
    duplication: { ...base.duplication, ...patch.duplication },
    obs: { ...base.obs, ...patch.obs },
    untrustedContent: { ...base.untrustedContent, ...patch.untrustedContent },
    planGate: { ...base.planGate, ...patch.planGate },
    shell: { ...base.shell, ...patch.shell },
    intelligence: {
      ...base.intelligence,
      ...patch.intelligence,
      lessons: {
        ...base.intelligence.lessons,
        ...patch.intelligence?.lessons,
      },
    },
    codePaths: patch.codePaths ?? base.codePaths,
    mcpPrime: patch.mcpPrime ?? base.mcpPrime,
    bootstrapExtra: patch.bootstrapExtra ?? base.bootstrapExtra,
  };
}

function flagExists(root: string, flagName: string): boolean {
  return existsSync(join(flagsDir(root), flagName));
}

type ConfigPair = { fromUser: PartialPolicy; fromProject: PartialPolicy };

function readConfigPair(root: string): ConfigPair {
  return {
    fromUser: readJsonFile<PartialPolicy>(machineConfigPath()) ?? {},
    fromProject: readJsonFile<PartialPolicy>(projectConfigPath(root)) ?? {},
  };
}

// hazard: written twice at first — once here and once inline in `loadPolicy` — so a change to which config wins
// moved one caller and left the other. A discrimination sensor caught it: reversing the precedence in one place
// failed one suite and left the other fully green.
function postureOf(root: string, pair: ConfigPair): PostureResolution {
  return resolvePosture(root, pair.fromProject.mode ?? pair.fromUser.mode);
}

/**
 * invariant: the resolution the loader itself applies, origin included. `status` and `doctor` need the origin
 * and the rejected value, which `Policy.mode` cannot carry — reading it from here is what stops either of them
 * from recomputing a posture and reporting the opposite of what the hooks resolved ([/decisions/ad-020.md](/decisions/ad-020.md)).
 */
export function resolveProjectPosture(root: string): PostureResolution {
  return postureOf(root, readConfigPair(root));
}

/**
 * invariant: the resolution the loader applies, with the value it came from. `loadPolicy` normalises the mode, so
 * the fact that a config still carries the old boolean is only recoverable here — and `lessons status` is where an
 * operator learns to update it ([/decisions/ad-050.md](/decisions/ad-050.md)).
 */
export function resolveProjectSyncMode(root: string): SyncModeResolution {
  const pair = readConfigPair(root);
  const fromProject = pair.fromProject.intelligence?.lessons?.syncRulesFile;
  const raw = fromProject ?? pair.fromUser.intelligence?.lessons?.syncRulesFile;
  const resolution = resolveSyncMode(raw);
  if (resolution.coercedFrom === undefined) {
    return resolution;
  }
  const path = fromProject === undefined ? machineConfigPath() : projectConfigPath(root);
  return { ...resolution, coercedIn: path };
}

export function loadPolicy(root: string): Policy {
  const pair = readConfigPair(root);
  const merged = deepMerge(deepMerge(DEFAULTS, pair.fromUser), pair.fromProject);
  merged.mode = postureOf(root, pair).mode;

  // why: grind is decided by its own switch and its own flag. Posture used to force it on, which meant a
  // surfacing preference silently overrode a capability with its own documented trade-off — the AD-020 defect.
  // Verification does not move when posture moves.
  if (flagExists(root, "grind-on")) {
    merged.grind.enabled = true;
  }

  // why: normalised here rather than at each read site, so `Policy` stays honestly typed and a config written
  // before the mode existed keeps the behaviour its operator chose ([/decisions/ad-050.md](/decisions/ad-050.md)).
  merged.intelligence.lessons.syncRulesFile = lessonsSyncMode(merged.intelligence.lessons.syncRulesFile);

  return merged;
}

/**
 * The policy as it would be with this project's config absent — `DEFAULTS` merged with the user tier.
 *
 * why here: the merge lives in this module, and asking "what would this resolve to without the project file" with
 * a second copy of the merge is how the two answers drift ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
export function resolvedWithoutProjectTier(): Record<string, unknown> {
  const fromUser = readJsonFile<PartialPolicy>(machineConfigPath()) ?? {};
  return deepMerge(DEFAULTS, fromUser) as unknown as Record<string, unknown>;
}

export function isUnderCodePaths(relativePath: string, codePaths: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return codePaths.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
