import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Commit,
  planVersion,
  tagPrefixFor,
  type VersionPlan,
} from "../../src/core/release/release.version.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * why: a separator git will never emit inside a subject or a body. `%n` would split bodies into fake commits, and
 * a blank line would too — a body with a blank line is the common case, not the edge case.
 *
 * hazard: the first version put the byte in the format string directly and Node refused the argument —
 * `must be a string without null bytes`. `%x1e` is the literal git expands, so the argument stays printable.
 */
const RECORD_FORMAT = "%x1e";
const RECORD = "\u001e";

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function manifest(root: string): { name: string; version: string } {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
}

/**
 * invariant: sorted by version, not by date. A tag pushed out of order — a re-tag, a backfill — must not become
 * "the last release" merely because it arrived last.
 */
export function lastReleaseTag(cwd: string, packageName: string): string | null {
  const listed = git(["tag", "--list", `${tagPrefixFor(packageName)}*`, "--sort=-v:refname"], cwd);
  const first = listed.split("\n")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

export function commitsSince(tag: string | null, cwd: string): Commit[] {
  const range = tag === null ? "HEAD" : `${tag}..HEAD`;
  const raw = git(["log", range, `--format=%s%n%b${RECORD_FORMAT}`], cwd);
  return raw
    .split(RECORD)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const [subject = "", ...rest] = block.split("\n");
      return { subject, body: rest.join("\n") };
    });
}

export type ReleasePlan = VersionPlan & { tag: string; since: string | null };

/**
 * hazard: the base is the last *tag*, not `package.json`. A version in the manifest that no tag corresponds to is
 * exactly the state that made the previous tool reprocess history and bump six times in nine minutes — reading the
 * tag makes an untagged manifest unable to move the base at all
 * ([/decisions/ad-087.md](/decisions/ad-087.md)).
 */
export function plan(root: string): ReleasePlan {
  const { name } = manifest(root);
  const since = lastReleaseTag(root, name);
  const base = since === null ? "0.0.0" : (since.slice(tagPrefixFor(name).length) ?? "0.0.0");
  const computed = planVersion(base, commitsSince(since, root));
  return { ...computed, tag: `${tagPrefixFor(name)}${computed.next}`, since };
}

if (import.meta.main) {
  const result = plan(repoRoot);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  // why: `name=value` lines, so the workflow reads this straight into $GITHUB_OUTPUT with no jq and no YAML parsing.
  console.log(
    [
      `released=${result.released}`,
      `current=${result.current}`,
      `version=${result.next}`,
      `tag=${result.tag}`,
      `bump=${result.bump}`,
    ].join("\n"),
  );
  console.error(
    result.released
      ? `next-version: ${result.current} → ${result.next} (${result.bump}), earned by ${result.reasons.length} commit(s) since ${result.since ?? "the first commit"}`
      : `next-version: nothing releasable since ${result.since ?? "the first commit"} — staying on ${result.current}`,
  );
}
