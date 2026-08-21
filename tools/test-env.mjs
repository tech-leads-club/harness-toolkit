/**
 * Loaded with `node --import` before every test file, so the suite answers from its own fixtures instead of
 * from the shell that happened to start it.
 *
 * hazard: `projectDirFor` prefers `CLAUDE_PROJECT_DIR` over the payload's `cwd`, which is correct in
 * production — the env var is the project root and `cwd` can be a subdirectory. Inside a Claude Code hook that
 * variable is always set, so 22 tests that build a fixture in a temp directory silently read policy and state
 * from the real repository instead. The suite passed from a shell and failed from inside a hook.
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_SCOPED_ENV, RUNTIME_SCOPED_ENV } from "./test-env.names.mjs";

for (const name of PROJECT_SCOPED_ENV) {
  delete process.env[name];
}

/**
 * hazard: `TLC_HOME` was left alone on the reasoning that it names which runtime and CI sets it deliberately. That
 * held only while nothing machine-wide lived under it. The global lesson tier does, so a test calling `allLessons`
 * without pinning the home read whichever lessons the developer happened to have promoted — green on a fresh
 * machine, green in CI, red on mine the moment I promoted five ([/decisions/ad-042.md](/decisions/ad-042.md)).
 *
 * invariant: hermetic by default, opt in by assignment. A test that wants a runtime home sets one; a test that
 * forgets gets an empty directory rather than a person's machine.
 */
process.env.TLC_HOME = mkdtempSync(join(tmpdir(), "tlc-test-home-"));

/**
 * hazard: redirecting `TLC_HOME` is not enough, because the installer deliberately ignores it unless
 * `TLC_HOME_FROM_ENV` says an operator chose it — and `TLC_ORIGIN` names the copy to install *from*. The gate
 * runs the suite through the CLI, which sets both, so a test that spawned a shipped bundle had it resolve the
 * real conventional home with the real repository as its source. On a machine installed with `--link` that home
 * is a symlink to the checkout, and the install deleted the repository's own `bin/` mid-gate. Both names are
 * scrubbed here, so a test that wants either sets it ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
for (const name of RUNTIME_SCOPED_ENV) {
  delete process.env[name];
}
process.env.TLC_INSTALL_DEST = mkdtempSync(join(tmpdir(), "tlc-test-dest-"));

/**
 * hazard: `wireRuntime` links the `tlc` command into `TLC_BIN_DIR`, default `~/.local/bin`. The suite calls it with
 * a temp runtime, so a test wrote a launcher into the operator's real bin directory pointing at a temp directory
 * that the same test then deleted — `tlc` on a live machine became a dangling link to `/tmp`. Found on the machine
 * it happened to ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * invariant: redirected, not deleted. A test that wants a bin directory sets one; a test that forgets gets a
 * throwaway rather than a person's `PATH`.
 */
process.env.TLC_BIN_DIR = mkdtempSync(join(tmpdir(), "tlc-test-bin-"));

/**
 * A fake home, and the provider directories inside it.
 *
 * hazard: everything above was patched one name at a time, after each one reached a live machine. Eleven call sites resolve
 * the home across five files — `platform/paths.ts`, `core/floor/floor.paths.ts`, `bin/tlc-exec.mjs`,
 * `tools/uninstall-runtime.ts` and `tools/doctor.ts` — and none of them was redirected. So `wireRuntime` in a test linked skills into the operator's own
 * `~/.cursor/skills` and merged their `settings.json`, and the only reason nothing broke is that no test happened to
 * step there. Redirecting the home closes the class rather than the instances
 * ([/decisions/ad-102.md](/decisions/ad-102.md)).
 *
 * why the provider variables too: `claudeConfigDir` and `cursorConfigDir` prefer them over `homedir()`, so a home
 * redirect alone would still be overridden on a machine that sets either — and this repository is itself installed
 * under a relocated one.
 *
 * why `USERPROFILE`: it is what `os.homedir()` reads on Windows.
 */
/**
 * hazard: the guards for this redirect built "the real paths on this machine" from `homedir()` — which by then
 * answers the fake, so the assertion whose message says *points at a real path on this machine* had stopped being
 * able to see one. And the one test written as the negative of the whole claim read `TLC_TEST_REAL_HOME`, which
 * nothing set, so it returned on its first line every run. Both found by an independent review
 * ([/decisions/ad-102.md](/decisions/ad-102.md)).
 *
 * invariant: captured before the redirect, and published, so a guard can compare against the machine this is
 * actually running on.
 */
process.env.TLC_TEST_REAL_HOME = homedir();

const fakeHome = mkdtempSync(join(tmpdir(), "tlc-test-home-dir-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, ".claude");
process.env.CURSOR_CONFIG_DIR = join(fakeHome, ".cursor");
