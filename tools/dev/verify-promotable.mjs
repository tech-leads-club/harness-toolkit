/**
 * Whether a version may be promoted: it exists on the registry, and its release actually finished.
 *
 * why a script and not inline shell: the same three checks written in the workflow could only be asserted by
 * substring, and a substring assertion cannot see the logic being neutered — a probe that wrapped one check in
 * `false &&` left the test green. Logic that matters belongs where it can be executed against inputs
 * ([/decisions/ad-102.md](/decisions/ad-102.md)).
 *
 * why all three: promoting from a half-finished release is how a version nobody meant to ship becomes the one every
 * new machine installs. A published version with no git tag, or a tag with no GitHub release, means the previous run
 * stopped in the window between `npm publish` and the push — the one window that needs a human
 * ([/decisions/ad-087.md](/decisions/ad-087.md)).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** invariant: injectable, so the decision is testable without a registry, a remote, or a token. */
export function defaultProbes() {
  const ok = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status === 0;
  return {
    publishedOnNpm: (pkg, version) => ok("npm", ["view", `${pkg}@${version}`, "version"]),
    gitTagExists: (tag) => ok("git", ["rev-parse", "--verify", `refs/tags/${tag}`]),
    releaseExists: (tag) => ok("gh", ["release", "view", tag]),
  };
}

export function tagFor(version) {
  return `harness-toolkit-v${version}`;
}

/**
 * invariant: every failing claim is reported, not the first. An operator fixing one and running again to find the
 * next is the loop this avoids ([/decisions/ad-030.md](/decisions/ad-030.md)).
 */
export function promotionProblems(pkg, version, probes) {
  const tag = tagFor(version);
  const problems = [];
  if (!probes.publishedOnNpm(pkg, version)) {
    problems.push(`npm has no ${pkg}@${version} — promote a version that is published`);
  }
  if (!probes.gitTagExists(tag)) {
    problems.push(`no git tag ${tag} — that release did not finish`);
  }
  if (!probes.releaseExists(tag)) {
    problems.push(`no GitHub release for ${tag} — that release did not finish`);
  }
  return problems;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node tools/dev/verify-promotable.mjs <version>");
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8")).name;
  const problems = promotionProblems(pkg, version, defaultProbes());
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log(`verify-promotable: ${pkg}@${version}, tag ${tagFor(version)}, and its GitHub release all exist`);
}
