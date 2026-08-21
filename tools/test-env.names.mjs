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
export const REDIRECTED_ENV = [
  // why listed even though it predates this list: it is a redirected destination like the others, and leaving it
  // undeclared meant the guards below never checked it. Found by the test that pairs declared with done
  // ([/decisions/ad-102.md](/decisions/ad-102.md)).
  "TLC_HOME",
  "TLC_INSTALL_DEST",
  "TLC_BIN_DIR",
  // hazard: eleven call sites resolve the home across five files, and none of them was redirected. Every one goes
  // through `os.homedir()`, which is why redirecting the variable closes the class rather than the instances —
  // verified by an independent review that found no `os.userInfo()` and no `HOMEDRIVE`/`HOMEPATH` anywhere. Two defects reached a live machine through
  // that gap in one afternoon: a test deleted the repository's own `bin/`, and a wiring step wrote a launcher into
  // the operator's `PATH` pointing at a temp directory it then removed. Each was patched by name. This is the
  // class ([/decisions/ad-102.md](/decisions/ad-102.md)).
  //
  // why `USERPROFILE` too: it is what `os.homedir()` reads on Windows, so redirecting only `HOME` would leave the
  // Windows leg of CI pointed at the runner's real profile.
  "HOME",
  "USERPROFILE",
  // why these as well: `claudeConfigDir` and `cursorConfigDir` honour them when set, so redirecting them is how a
  // test reaches a fake provider directory instead of the operator's own — and `wireRuntime` links skills and
  // merges hook documents into whatever those resolve to.
  "CLAUDE_CONFIG_DIR",
  "CURSOR_CONFIG_DIR",
];

/**
 * The third behaviour: a fact about the machine, published so a guard can compare against it.
 *
 * why not `REDIRECTED_ENV`: the guards there assert the value is a throwaway, and this one is deliberately the
 * operator's real home — it exists so the negative assertion ("nothing a suite writes can reach these") has a real
 * path to be negative about. Two behaviours in one list is how `TLC_BIN_DIR` broke a guard once already, so this is
 * its own ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
export const PUBLISHED_ENV = ["TLC_TEST_REAL_HOME"];
