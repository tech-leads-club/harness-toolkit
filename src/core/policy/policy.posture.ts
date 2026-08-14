import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flagsDir, projectStateDir } from "../../platform/paths.ts";
import type { OperatorMode } from "./policy.types.ts";

/**
 * The harness has three operator postures. They differ in exactly one dimension: how much the agent surfaces
 * and what earns an interruption. Everything about verification — the evidence bar, the gates, the
 * done-criteria — is identical at all three.
 *
 * invariant: one word per posture, everywhere. The CLI used to take `focus` for the deepest level while the
 * config field stored a second spelling, so a config written from the documented word matched no branch and
 * silently produced a policy with no posture line and grind left off. An alias would keep both names alive
 * behind a translation layer, which is the same defect wearing a coat.
 */
export const OPERATOR_MODES: readonly OperatorMode[] = ["paired", "solo", "focus"];

// why: the middle posture is the default. It is the one that needs no explanation to a new operator: work on
// your own, surface the things that genuinely need a person.
export const DEFAULT_POSTURE: OperatorMode = "solo";

export type PostureOrigin = "config" | "file" | "flag" | "fallback";

export type PostureResolution = {
  mode: OperatorMode;
  origin: PostureOrigin;
  /**
   * The rejected value, present only when `origin` is `fallback`. Three surfaces read it — the loader applies
   * the fallback, `status` shows the origin, `doctor` names the value — so a bad posture cannot be silent in
   * all of them at once.
   */
  invalid?: string;
};

// hazard: `deepMerge` copies `mode` out of config JSON without validating it, so the value reaching here can be
// any JSON type. Narrowing from `unknown` is what stops a number or a misspelling from being applied.
export function isOperatorMode(value: unknown): value is OperatorMode {
  return typeof value === "string" && (OPERATOR_MODES as readonly string[]).includes(value);
}

function readModeFile(root: string): string | null {
  const path = join(projectStateDir(root), "harness-mode");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readFileSync(path, "utf8").trim().toLowerCase();
  } catch {
    return null;
  }
}

/**
 * invariant: the only place that answers both "which posture" and "where did it come from". The loader,
 * `tlc harness status` and `tlc harness doctor` read this one result — status used to recompute posture on its
 * own and reported the opposite of what the hooks resolved ([/decisions/ad-020.md](/decisions/ad-020.md)).
 *
 * Precedence is unchanged: mode state file, then the posture flag files, then config, then the default.
 */
export function resolvePosture(root: string, configured: unknown): PostureResolution {
  const fromFile = readModeFile(root);
  if (isOperatorMode(fromFile)) {
    return { mode: fromFile, origin: "file" };
  }
  for (const mode of ["focus", "paired"] as const) {
    if (existsSync(join(flagsDir(root), mode))) {
      return { mode, origin: "flag" };
    }
  }
  if (isOperatorMode(configured)) {
    return { mode: configured, origin: "config" };
  }
  // why: an absent value is not a fault — the default applies and there is nothing to report. Only a value that
  // was written and cannot be honoured becomes a fallback the operator needs to see.
  if (configured === undefined || configured === null) {
    return { mode: DEFAULT_POSTURE, origin: "config" };
  }
  return { mode: DEFAULT_POSTURE, origin: "fallback", invalid: String(configured) };
}
