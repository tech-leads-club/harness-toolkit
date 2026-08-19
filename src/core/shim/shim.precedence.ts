/**
 * Whether the project-level shim should stand down because a user-level hook already covers this event.
 *
 * hazard: this was `if (process.env.TLC_ACTIVE === "1")`, and nothing in the repository ever set `TLC_ACTIVE`.
 * Four documents stated that the user-level `sessionStart` hook sets it; none could, because a hook cannot export
 * an environment variable to a later hook process — the host's own documentation says there is no field that
 * passes state between hook invocations. So the condition was never true, the shim never stood down, and both
 * levels ran the handler on every overlapping event. Measured on one machine: eleven hook groups registered at
 * user level, six at project level, six events overlapping, and the host merges rather than replaces — it
 * deduplicates only byte-identical handlers, and these differ (`… tlc-exec.mjs shim stop` against
 * `… tlc-exec.mjs stop`) ([/decisions/ad-095.md](/decisions/ad-095.md)).
 *
 * invariant: the answer is derived from what is on disk, not from what a previous process might have exported.
 * Two hooks in the same event are separate processes with no channel between them, so the only thing they can
 * agree on is a file both can read.
 */

export type HookEntry = { command?: string; args?: readonly string[] };
export type HookMatcher = { hooks?: readonly HookEntry[] };
export type ProviderSettings = { hooks?: Record<string, readonly HookMatcher[]> };

/**
 * why: the launcher's file name, not its full path. The user-level hook names the runtime home
 * (`~/.tlc/harness/bin/tlc-exec.mjs`) and the project shim names wherever init resolved the runtime from — the
 * paths differ by construction, so comparing them would never match. What identifies the harness is the launcher
 * it runs and the handler it runs it with.
 */
export const LAUNCHER = "tlc-exec";

export function invocationText(entry: HookEntry): string {
  return [entry.command ?? "", ...(entry.args ?? [])].join(" ");
}

/**
 * Does this settings document already run the harness for this handler?
 *
 * invariant: `shim` is not part of the comparison. The user-level hook runs `tlc-exec <handler>` and the project
 * shim runs `tlc-exec shim <handler>` — the same handler reached two ways. Requiring the spellings to match is
 * what made the host's own deduplication miss them.
 */
export function coversHandler(settings: ProviderSettings, handler: string): boolean {
  for (const matchers of Object.values(settings.hooks ?? {})) {
    for (const matcher of matchers) {
      for (const entry of matcher.hooks ?? []) {
        const text = invocationText(entry);
        if (text.includes(LAUNCHER) && new RegExp(`(^|\\s)${handler}(\\s|$)`).test(text)) {
          return true;
        }
      }
    }
  }
  return false;
}

export type ShimDecision = { run: boolean; reason: string };

/**
 * why: `null` for the user-level settings means "there is no user-level install", which is the case the project
 * shim exists for — a cloud agent with no user-level hooks runs the real handler through it
 * (`docs/architecture.md`). Absence must therefore mean run, and only a positive match means stand down.
 */
export function decideShim(userSettings: ProviderSettings | null, handler: string): ShimDecision {
  if (userSettings === null) {
    return { run: true, reason: "no user-level settings — this shim is the only hook for this event" };
  }
  return coversHandler(userSettings, handler)
    ? {
        run: false,
        reason: `a user-level hook already runs ${handler} — standing down to avoid a second run`,
      }
    : { run: true, reason: `no user-level hook runs ${handler}` };
}
