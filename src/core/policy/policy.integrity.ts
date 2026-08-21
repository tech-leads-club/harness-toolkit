import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision } from "../../contracts/decision.ts";
import {
  flagsDir,
  machineConfigPath,
  policyBaselineDir,
  projectConfigPath,
  projectStateDir,
} from "../../platform/paths.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";

export type PolicySource = { path: string; hash: string };

const ABSENT = "absent";
const SCHEMA = "harness.policy-baseline.v1";

// why: every file `loadPolicy` consults. A mutation that changed the effective policy without touching one
// of these would be a change the loader cannot see either.
const MODE_FILE = "harness-mode";
// why: every file the loader consults. The posture flags carry the posture names, so renaming a posture
// renames its flag — a stale file from the old spelling decides nothing and is not hashed.
const FLAG_FILES = ["grind-on", "skip-verify", "focus", "paired"];

function hashOf(path: string): string {
  if (!existsSync(path)) {
    return ABSENT;
  }
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // hazard: an unreadable source must not read as unchanged, or a policy made unreadable mid-session
    // would pass silently. It gets its own marker instead.
    return "unreadable";
  }
}

export function policySourceFingerprint(root: string): PolicySource[] {
  const paths = [
    projectConfigPath(root),
    machineConfigPath(),
    join(projectStateDir(root), MODE_FILE),
    ...FLAG_FILES.map((flag) => join(flagsDir(root), flag)),
  ];
  return paths.map((path) => ({ path, hash: hashOf(path) }));
}

function baselinePath(root: string, sessionKey: string): string {
  return join(policyBaselineDir(root), `${sanitizeSegment(sessionKey)}.json`);
}

export function recordPolicyBaseline(root: string, sessionKey: string): void {
  try {
    mkdirSync(policyBaselineDir(root), { recursive: true });
    writeFileSync(
      baselinePath(root, sessionKey),
      `${JSON.stringify({ schema: SCHEMA, sources: policySourceFingerprint(root) }, null, 2)}\n`,
      "utf8",
    );
  } catch {}
}

function readBaseline(root: string, sessionKey: string): PolicySource[] | null {
  const path = baselinePath(root, sessionKey);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { sources?: PolicySource[] };
    return Array.isArray(parsed.sources) ? parsed.sources : null;
  } catch {
    return null;
  }
}

/**
 * hazard: this compared every current source against the baseline, so a path the baseline had never heard of
 * counted as divergence. That is not a policy change — it means the harness's own list of policy sources grew
 * or was renamed, which happens on upgrade. Renaming a posture flag made this fire against its own author, and
 * it would have accused every operator with a live session of tampering the moment they updated the harness.
 *
 * invariant: only paths present in both are compared, and a hash that moved still fires. An out-of-band flag
 * write is caught because the baseline records absent sources too, so that source goes from `absent` to a hash
 * on a path the baseline already knows — detection is untouched.
 */
function divergedIn(baseline: PolicySource[], current: PolicySource[]): string[] {
  const recorded = new Map(baseline.map((source) => [source.path, source.hash]));
  return current
    .filter((source) => {
      const was = recorded.get(source.path);
      return was !== undefined && was !== source.hash;
    })
    .map((source) => source.path);
}

/**
 * why: every diverged path, not the first. Reporting one at a time makes an operator repair, get blocked again, and
 * repair again — and accepting requires the full list anyway
 * ([/decisions/ad-030.md](/decisions/ad-030.md)).
 */
export function divergedPaths(root: string, sessionKey: string): string[] {
  const baseline = readBaseline(root, sessionKey);
  return baseline === null ? [] : divergedIn(baseline, policySourceFingerprint(root));
}

/** why: the union across live sessions, so a listing shows what the operator has to deal with, not one session's view. */
export function allDivergedPaths(root: string): string[] {
  const dir = policyBaselineDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  const found = new Set<string>();
  const current = policySourceFingerprint(root);
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const baseline = readBaseline(root, entry.replace(/\.json$/, ""));
    if (baseline) {
      for (const path of divergedIn(baseline, current)) {
        found.add(path);
      }
    }
  }
  return [...found].sort();
}

export type AcceptOutcome =
  | { kind: "accepted"; paths: string[] }
  | { kind: "not-a-source"; paths: string[]; sources: string[] }
  | { kind: "nothing-to-accept" };

/**
 * invariant: per source. `refreshPolicyBaselines` rewrites the whole fingerprint, so using it here would silently
 * accept every *other* change alongside the one named — which is the hole this closes. Each named path gets its
 * current hash written into every live session's baseline; every other entry is left exactly as it was, so a second
 * divergence still fires.
 *
 * invariant: no blanket permission is expressible. The accepted hash is the hash at this moment, so a later change
 * to the same file diverges again. There is deliberately no way to stop watching a source.
 *
 * hazard: this is the one function in the codebase whose job is to clear a tampering signal. It reads no policy and
 * makes no judgement — the four locks that keep it out of an agent's reach live at the CLI and in the floor, where
 * they can be tested independently ([/decisions/ad-030.md](/decisions/ad-030.md)).
 */
export function acceptPolicySources(root: string, paths: string[]): AcceptOutcome {
  const current = policySourceFingerprint(root);
  const known = new Map(current.map((source) => [source.path, source.hash]));
  const unknown = paths.filter((path) => !known.has(path));
  if (unknown.length > 0) {
    return { kind: "not-a-source", paths: unknown, sources: current.map((source) => source.path) };
  }

  const dir = policyBaselineDir(root);
  if (!existsSync(dir) || paths.length === 0) {
    return { kind: "nothing-to-accept" };
  }

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const sessionKey = entry.replace(/\.json$/, "");
    const baseline = readBaseline(root, sessionKey);
    if (!baseline) {
      continue;
    }
    const updated = baseline.map((source) =>
      paths.includes(source.path) ? { path: source.path, hash: known.get(source.path) as string } : source,
    );
    try {
      writeFileSync(
        join(dir, entry),
        `${JSON.stringify({ schema: SCHEMA, sources: updated }, null, 2)}\n`,
        "utf8",
      );
    } catch {}
  }
  return { kind: "accepted", paths };
}

// invariant: this is the layer that covers what shell parsing cannot — `bash script.sh`, a compiled binary,
// a path built at runtime. It reads the policy's *bytes*, never its values, so nothing inside the policy can
// switch off the check that watches it.
export function checkPolicyBaseline(root: string, sessionKey: string): Decision {
  const baseline = readBaseline(root, sessionKey);
  // why: a missing baseline is the first hook of a session, not evidence of tampering. Recording and
  // allowing is the only safe reading — blocking here would break every fresh session.
  if (!baseline) {
    recordPolicyBaseline(root, sessionKey);
    return { kind: "allow" };
  }

  const diverged = divergedIn(baseline, policySourceFingerprint(root));
  if (diverged.length === 0) {
    return { kind: "allow" };
  }

  /**
   * hazard: the reason used to end "the harness commands re-record the baseline when they write" — and the floor
   * refuses every one of those commands from inside a session. A blocked agent read it as a route, tried one, and
   * stayed blocked. `reason` reaches the agent and `userNote` reaches the operator; the fix is to stop putting the
   * operator's instructions in the agent's half ([/decisions/ad-030.md](/decisions/ad-030.md)).
   */
  return {
    kind: "deny",
    reason: [
      `HARNESS: ${diverged.join(", ")} changed during this session, and no harness command changed it.`,
      "The gates are now running a policy the operator did not set, so what they check cannot be trusted.",
      "Report this to the operator and name the paths above. Only they can clear it, from their own terminal — the harness commands that would are refused from inside a session, so there is nothing for you to run here.",
    ].join("\n"),
    userNote: [
      `Harness policy changed out of band during this session: ${diverged.join(", ")}.`,
      `If that was you, accept it with: tlc harness policy accept ${diverged.join(" ")}`,
    ].join(" "),
    rule: "policy-baseline-divergence",
  };
}

// why: the CLI is the sanctioned mutator, so after it writes, every live session's baseline is refreshed.
// It cannot know which sessions are live, which is exactly why it refreshes all of them — and it makes
// "a harness command did this" and "the baseline matches" the same fact, with no second log to drift.
export function refreshPolicyBaselines(root: string): void {
  const dir = policyBaselineDir(root);
  if (!existsSync(dir)) {
    return;
  }
  const sources = policySourceFingerprint(root);
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      writeFileSync(join(dir, entry), `${JSON.stringify({ schema: SCHEMA, sources }, null, 2)}\n`, "utf8");
    } catch {}
  }
}
