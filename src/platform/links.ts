/**
 * The two filesystem primitives an install needs: a directory link, and a config seeded once.
 *
 * why there is no platform branch here: the code this replaces shelled out to `ln -sfn` on POSIX and to
 * PowerShell on Windows, and *that* is where the branch came from — not from anything Node cannot do. Node's
 * `symlinkSync` takes a link type that is only meaningful on Windows and is ignored elsewhere, so `"junction"`
 * is correct on all three platforms: a junction on Windows, a plain symlink on Linux and macOS. Measured on
 * Linux, and stated in Node's own API history ([/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * why junction rather than a Windows symlink: a directory symlink needs Developer Mode or an elevated shell,
 * which the PowerShell installer demanded of a contributor. A junction needs neither.
 *
 * The launcher on PATH is not here either. `npm i -g` generates the shims for the platform it runs on, and
 * `npm link` does the same from a checkout — a second implementation of that is a second thing to get wrong.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** invariant: one link type, chosen because Windows is the only platform that reads it. */
export const LINK_TYPE = "junction";

export type LinkOutcome =
  | { kind: "linked"; target: string; source: string }
  | { kind: "relinked"; target: string; source: string }
  | { kind: "refused"; target: string; reason: string };

/**
 * Point `target` at `source`.
 *
 * invariant: an existing *link* is replaced; anything else is refused. A real directory at the target is either
 * somebody's install or somebody's work, and removing it to make room is not a decision a tool makes
 * ([/decisions/ad-046.md](/decisions/ad-046.md)). The bash installer removed it.
 */
export function linkDir(source: string, target: string): LinkOutcome {
  let replaced = false;
  if (isLink(target)) {
    rmSync(target, { recursive: true, force: true });
    replaced = true;
  } else if (existsSync(target)) {
    return {
      kind: "refused",
      target,
      reason: `${target} exists and is not a link — move it aside and re-run`,
    };
  }
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, LINK_TYPE);
  return { kind: replaced ? "relinked" : "linked", target, source };
}

/**
 * why lstat: a link whose destination is gone is still a link, and `existsSync` says it is not there — so the
 * check has to come first, or a dangling link reads as free space. Node reports a Windows junction as a symbolic
 * link, so one call covers both kinds.
 */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** invariant: seeded once, never overwritten. The operator's config is theirs from the moment it exists. */
export function seedConfig(dest: string): { seeded: boolean; path: string } {
  const path = join(dest, "config.json");
  const example = join(dest, "config.example.json");
  if (existsSync(path) || !existsSync(example)) {
    return { seeded: false, path };
  }
  copyFileSync(example, path);
  return { seeded: true, path };
}
