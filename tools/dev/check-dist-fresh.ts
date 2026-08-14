import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// hazard: install.sh does not compile, so a user without Bun runs whatever dist/ was committed, and
// nothing kept those bundles matching src. They drifted once already, silently.
// invariant: the bundles embed their source paths, so bytes built in a scratch directory never match.
// Building in place and asking git is the only comparison that answers the real question.
export function rebuildAndDiff(root = repoRoot): string[] {
  execFileSync(join(root, "bin", "tlc-build"), [], { cwd: root, stdio: "pipe" });
  // hazard: `git status` also reports staged paths, so it fails during the very commit that fixes
  // dist. Comparing the rebuild against HEAD asks whether the committed bundles are stale.
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "dist"], {
    cwd: root,
    encoding: "utf8",
  });
  return changed
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path !== "");
}

if (import.meta.main) {
  const stale = rebuildAndDiff();
  if (stale.length === 0) {
    console.log("check-dist-fresh: dist/ matches src/");
    process.exit(0);
  }
  console.error(`check-dist-fresh: ${stale.length} bundle(s) were stale and have been rebuilt in place.`);
  console.error("Commit dist/ alongside the src change that caused it.");
  for (const path of stale) {
    console.error(`  ${path}`);
  }
  process.exit(1);
}
