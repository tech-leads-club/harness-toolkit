import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// why: a denylist of one operator's name would pass on every other machine. Any absolute home path is
// refused, and the only accepted spellings are these placeholders — named here so adding one is a decision
// a reviewer sees rather than a regex nobody reads.
export const PLACEHOLDER_NAMES = new Set([
  "dev",
  "x",
  "user",
  "you",
  "me",
  "operator",
  "someone",
  "test",
  "tester",
]);

const HOME_PATTERNS = [
  /\/home\/([^/\s"'`,)\]}]+)\//g,
  /\/Users\/([^/\s"'`,)\]}]+)\//g,
  /[A-Za-z]:\\+Users\\+([^\\\s"'`,)\]}]+)/g,
];

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".pdf",
  ".woff",
  ".woff2",
]);

export function trackedFiles(root = repoRoot): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .filter((path) => ![...BINARY_EXTENSIONS].some((extension) => path.toLowerCase().endsWith(extension)));
}

export type Leak = { file: string; match: string; name: string };

// why: a test that exercises this gate has to contain a realistic account name, and so does a fixture that
// proves a resolver works. The exception is per line and spelled out, so it is visible to a reviewer and
// greppable — a generated file would never carry the marker.
export const ALLOW_MARKER = "leak-gate-allow";

export function findPersonalPaths(text: string, file: string): Leak[] {
  const leaks: Leak[] = [];
  for (const line of text.split("\n")) {
    if (line.includes(ALLOW_MARKER)) {
      continue;
    }
    for (const pattern of HOME_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const name = (match[1] ?? "").toLowerCase();
        if (PLACEHOLDER_NAMES.has(name)) {
          continue;
        }
        leaks.push({ file, match: match[0], name });
      }
    }
  }
  return leaks;
}

describe("findPersonalPaths", () => {
  test("accepts the documented placeholders", () => {
    assert.deepEqual(findPersonalPaths("run it from /home/dev/repo and /home/x/y", "f"), []);
    assert.deepEqual(findPersonalPaths("C:\\Users\\dev\\project", "f"), []);
  });

  test("refuses a real account name on every platform spelling", () => {
    assert.equal(findPersonalPaths("/home/jsmith/repos/thing", "f").length, 1); // leak-gate-allow
    assert.equal(findPersonalPaths("/Users/jsmith/repos/thing", "f").length, 1); // leak-gate-allow
    assert.equal(findPersonalPaths("C:\\Users\\jsmith\\thing", "f").length, 1); // leak-gate-allow
  });

  test("reports what it found, so the failure names the leak", () => {
    const [leak] = findPersonalPaths("/home/jsmith/x/", "settings.json"); // leak-gate-allow
    assert.equal(leak?.file, "settings.json");
    assert.equal(leak?.name, "jsmith");
    assert.match(leak?.match ?? "", /jsmith/);
  });

  test("a line carrying the allow marker is skipped, and only that line", () => {
    const text = ["/home/jsmith/one/ // leak-gate-allow", "/home/jsmith/two/"].join("\n");
    const leaks = findPersonalPaths(text, "f");
    assert.equal(leaks.length, 1);
    assert.match(leaks[0]?.match ?? "", /jsmith/);
  });

  test("a home path with no trailing segment is not a match, which keeps prose about ~/ quiet", () => {
    assert.deepEqual(findPersonalPaths("under /home or $HOME", "f"), []);
  });
});

// hazard: this product is installed with a shell one-liner and its bundles are tracked, so a generated file
// is exactly where an operator's account name would slip in unnoticed. The gate reads what git actually
// tracks rather than a curated list.
describe("the repository carries no personal identity", () => {
  test("no tracked file contains an absolute home path outside the placeholder allowlist", () => {
    const leaks: Leak[] = [];
    for (const file of trackedFiles()) {
      let content: string;
      try {
        content = readFileSync(join(repoRoot, file), "utf8");
      } catch {
        continue;
      }
      leaks.push(...findPersonalPaths(content, file));
    }
    assert.deepEqual(
      leaks.map((leak) => `${leak.file}: ${leak.match}`),
      [],
      "tracked files must not carry an operator's home path",
    );
  });

  /**
   * hazard: the bundles are no longer tracked, so the sweep over `git ls-files` above cannot see them — and they
   * are what ships in the tarball. A generated file is exactly where an operator's account name slips in
   * unnoticed, so they are read from disk instead ([/decisions/ad-097.md](/decisions/ad-097.md)).
   *
   * invariant: the check covers what is published, not what is committed. Those are now different sets.
   */
  test("the generated bundles carry no personal path either", () => {
    const dist = join(repoRoot, "dist");
    if (!existsSync(dist)) {
      // why: a clone that has not built yet is not a failure. The build step in CI runs before the gate.
      return;
    }
    const bundles = readdirSync(dist).filter((name: string) => name.endsWith(".mjs"));
    assert.ok(bundles.length > 0, "dist/ exists but holds no bundle — the build did not run");

    const leaks: Leak[] = [];
    for (const name of bundles) {
      leaks.push(...findPersonalPaths(readFileSync(join(dist, name), "utf8"), `dist/${name}`));
    }
    assert.deepEqual(
      leaks.map((leak) => `${leak.file}: ${leak.match}`),
      [],
    );
  });

  test("per-machine shim files are not tracked", () => {
    const tracked = new Set(trackedFiles());
    assert.equal(tracked.has(".cursor/hooks.json"), false);
    assert.equal(tracked.has(".claude/settings.json"), false);
  });
});
