/**
 * why: variables that name WHICH project. A gate that runs with one of these set is reading a project root the
 * hook supplied rather than the one the command assumed, and a suite that builds fixtures in temp directories
 * reads the real repository under them. That is documented in `tools/test-env.mjs` and it cost four stop loops
 * of editing code that was not broken ([/decisions/ad-060.md](/decisions/ad-060.md)).
 *
 * invariant: this list lives in `platform/` because `core/` may not spell a vendor identifier
 * (`tools/check-boundaries.ts`). Core asks which ones are set and never names one.
 *
 * invariant: `TLC_HOME` is deliberately absent. It names which runtime, not which project, and CI sets it on
 * purpose.
 */
export const PROJECT_SCOPED_ENV_NAMES = [
  "CLAUDE_PROJECT_DIR",
  "CURSOR_PROJECT_DIR",
  "TLC_PROJECT_DIR",
] as const;

/** The names that are set and non-empty, in declaration order, so the reading is stable across runs. */
export function setProjectScopedEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return PROJECT_SCOPED_ENV_NAMES.filter((name) => (env[name] ?? "").trim() !== "");
}
