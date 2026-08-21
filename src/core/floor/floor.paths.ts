import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  flagsDir,
  machineConfigPath,
  projectConfigPath,
  projectStateDir,
  runtimeStateDir,
} from "../../platform/paths.ts";
import { normalizeSeparators } from "../../platform/sanitize.ts";

export function expandHome(text: string, home = homedir()): string {
  if (text === "~") {
    return home;
  }
  return text.startsWith(`~${sep}`) || text.startsWith("~/") ? resolve(home, text.slice(2)) : text;
}

export function resolveTarget(projectDir: string, word: string, home = homedir()): string {
  const expanded = expandHome(word, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(projectDir, expanded);
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// why: scratch space is where an agent is supposed to make a mess, so destruction there is not a floor
// concern even though it sits outside the project.
export function isScratch(target: string, tmp = tmpdir()): boolean {
  return isInside(tmp, target);
}

// hazard: the runtime config is merged by `loadPolicy` under the project one, so a field the project does
// not set is decided there — for every repository on the machine. Guarding only the project paths left
// `echo '{}' > ~/.tlc/harness/config.json` allowed, which is the same defect one directory up.
export function isRuntimePolicySurface(filePath: string): boolean {
  const target = resolve(filePath);
  return target === resolve(machineConfigPath()) || isInside(runtimeStateDir(), target);
}

// invariant: the policy surface is defined here, next to the floor's other path predicates, because the
// floor decides before any policy is read. Defining it inside the policy module would point the dependency
// backwards — against the order the two actually run in.
export function isPolicySurface(projectDir: string, filePath: string): boolean {
  if (isRuntimePolicySurface(filePath)) {
    return true;
  }
  const target = normalizeSeparators(relative(projectDir, filePath) || filePath);
  const config = normalizeSeparators(relative(projectDir, projectConfigPath(projectDir)));
  const flags = normalizeSeparators(relative(projectDir, flagsDir(projectDir)));
  const state = normalizeSeparators(relative(projectDir, projectStateDir(projectDir)));
  return target === config || target.startsWith(`${flags}/`) || target.startsWith(`${state}/`);
}

const SECRET_HOME_DIRS = [".ssh", ".aws", ".kube", ".gnupg", ".docker", ".config/gh", ".config/gcloud"];
const SECRET_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pgpass",
  "credentials",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);
const SECRET_SUFFIXES = [".pem", ".p12", ".pfx"];
// invariant: these are templates checked into repos on purpose — treating them as secrets would
// block ordinary work and teach the operator to distrust the floor.
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

function isEnvFile(name: string): boolean {
  if (name !== ".env" && !name.startsWith(".env.")) {
    return false;
  }
  return !ENV_TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function isSecretPath(target: string, home = homedir()): boolean {
  const name = basename(target);
  if (isEnvFile(name) || SECRET_BASENAMES.has(name)) {
    return true;
  }
  if (SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  return SECRET_HOME_DIRS.some((dir) => isInside(resolve(home, dir), target));
}
