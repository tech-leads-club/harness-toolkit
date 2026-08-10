/**
 * The names only, with no side effect, so a test can read them without performing the cleanup it is checking.
 *
 * hazard: this list lived in `test-env.mjs` next to the `delete` loop, and the guard test imported it from
 * there. Importing that module runs the loop, so the guard cleaned the very environment it was asserting about
 * and could never fail. Data and effect are separate for that reason.
 *
 * invariant: only variables that name WHICH project. `TLC_HOME` names which runtime, is set deliberately by
 * CI, and is part of what the suite exercises.
 */
// hazard: `CURSOR_PROJECT_DIR` was absent while `cursor.inbound.ts` prefers it over the payload's workspace
// root — the same hole this list exists to close, for the other provider. A suite launched from inside a Cursor
// hook would have read the real repository exactly as the Claude case did.
export const PROJECT_SCOPED_ENV = ["CLAUDE_PROJECT_DIR", "CURSOR_PROJECT_DIR", "TLC_PROJECT_DIR"];
