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

/**
 * The other half: variables that name WHICH runtime copy, rather than which project. `TLC_ORIGIN` is the source
 * to install from and `TLC_HOME_FROM_ENV` is what makes the installer honour `TLC_HOME` at all — so leaving them
 * set let a spawned bundle resolve the operator's real home with the real checkout as its source.
 */
export const RUNTIME_SCOPED_ENV = ["TLC_ORIGIN", "TLC_HOME_FROM_ENV"];

/**
 * The other half: variables that name a *destination*, which are redirected rather than deleted. Deleting them
 * sends an install or a wiring step at the machine's real paths, which is the opposite of hermetic.
 *
 * hazard: `TLC_BIN_DIR` was put in the delete list above, and the guard test — which asserts every name there is
 * absent — failed against a value the setup had deliberately set. Two behaviours in one list is how that happens,
 * so they are two lists ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
export const REDIRECTED_ENV = ["TLC_INSTALL_DEST", "TLC_BIN_DIR"];
