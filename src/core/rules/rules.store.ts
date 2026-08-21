/**
 * Where the harness records what it observed, and where it reads the rules from.
 *
 * invariant: the agent cannot write here. This lives under the project state directory, which the floor's
 * `policy-surface-write` refuses to an agent through a shell redirect, an interpreter or a write tool — and the
 * mutating `tlc harness` subcommands are refused from inside a session. So the only writer is the harness
 * observing a host event, which is what makes a proof unforgeable rather than conventional
 * ([/decisions/ad-100.md](/decisions/ad-100.md), [/decisions/ad-022.md](/decisions/ad-022.md)).
 *
 * why append-only jsonl and not a merged document: two sessions observe at the same time, and an append is the one
 * write that needs no lock. The reader takes the tail, because a proof is about now.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendRecord, readTail } from "../../platform/fs-jsonl.ts";
import { projectStateDir, runtimeHome } from "../../platform/paths.ts";
import type { RuleSource } from "./rules.parse.ts";
import type { Observation } from "./rules.proof.ts";
import type { RuleTier } from "./rules.types.ts";

/**
 * why a bound: an observation older than this window cannot satisfy `since HEAD` anyway, and a file that grows
 * without limit is a file nobody prunes. The tail is generous enough that a long session keeps its own proofs.
 */
const OBSERVATION_TAIL = 500;

export function observationsPath(root: string): string {
  return join(projectStateDir(root), "rule-observations.jsonl");
}

/** The project's rules, versioned with it. */
export function projectRulesDir(root: string): string {
  return join(projectStateDir(root), "..", "rules");
}

/** This machine's rules, every repository — the tier that follows the operator across products. */
export function globalRulesDir(): string {
  return join(runtimeHome(), "rules");
}

function readDir(dir: string, tier: RuleTier): RuleSource[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const path = join(dir, entry.name);
      return { name: basename(entry.name, ".md"), tier, text: readFileSync(path, "utf8") };
    });
}

/**
 * invariant: both tiers are read, global first, so `buildRuleSet` can let the project win by name. Absent
 * directories are absent rules, not an error — no rules means no behaviour change
 * ([/decisions/ad-040.md](/decisions/ad-040.md)).
 */
export function readRuleSources(root: string): RuleSource[] {
  return [...readDir(globalRulesDir(), "global"), ...readDir(projectRulesDir(root), "project")];
}

export function recordObservation(root: string, observation: Observation): void {
  try {
    appendRecord(observationsPath(root), observation);
  } catch {
    // why swallowed: an unwritable state directory must not fail the turn that was being observed. The proof will
    // be missing, which the gate reports as missing rather than as an error nobody can act on.
  }
}

export function readObservations(root: string): Observation[] {
  try {
    return readTail<Observation>(observationsPath(root), OBSERVATION_TAIL);
  } catch {
    return [];
  }
}
