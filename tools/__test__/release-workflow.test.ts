import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

/**
 * hazard: the release job's `git add` named `dist`, which was tracked when the line was written and is not any
 * more. `git add` on an ignored path exits 1, the step runs under `bash -e`, and the step comes AFTER `npm
 * publish` — so npm held 0.3.0 while `main` held 0.2.4, which is the single state the whole publish-before-push
 * ordering exists to avoid ([/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * why a test and not a comment: the same class of defect is one `.gitignore` line away at any time. The workflow
 * is the least-testable part of the release and the most expensive to get wrong, so what can be asserted from
 * here, is.
 */
function gitAddPaths(): string[] {
  const line = workflow.split("\n").find((text) => text.trim().startsWith("git add "));
  assert.ok(line, "the release job must still stage the release commit");
  return (line as string)
    .trim()
    .replace(/^git add /, "")
    .split(/\s+/)
    .filter((path) => path.length > 0);
}

describe("the release commit stages only paths git will accept", () => {
  test("AC every path the release job stages is not ignored", () => {
    const ignored = gitAddPaths().filter((path) => {
      try {
        execFileSync("git", ["check-ignore", "-q", path], { cwd: repoRoot, stdio: "ignore" });
        return true;
      } catch {
        // exit 1 means "not ignored", which is the answer this needs
        return false;
      }
    });

    assert.deepEqual(
      ignored,
      [],
      "an ignored path makes `git add` exit 1 after the publish has already happened",
    );
  });

  /** invariant: what the release commit carries is exactly what the version bump and the changelog rewrite. */
  test("AC it stages the manifest, the lockfile and the changelog", () => {
    assert.deepEqual(gitAddPaths().sort(), ["CHANGELOG.md", "package-lock.json", "package.json"]);
  });

  /**
   * invariant: the publish comes before anything reaches the remote, because npm is immutable after 72 hours and a
   * branch is not. This asserts the order in the file, which is the only place it is expressed
   * ([/decisions/ad-087.md](/decisions/ad-087.md)).
   */
  test("AC npm publish precedes the push, and the push precedes the GitHub release", () => {
    const publish = workflow.indexOf("- name: Publish to npm");
    const push = workflow.indexOf("- name: Push the commit and the tag");
    const release = workflow.indexOf("- name: Create the GitHub release");

    assert.ok(publish > 0 && push > 0 && release > 0, "all three steps must exist");
    assert.ok(publish < push, "publishing after the push is the ordering that stranded three tags");
    assert.ok(push < release, "a GitHub release names a tag, so the tag has to be there first");
  });

  /** invariant: the one job that writes is the one behind the approval, and it is behind an environment. */
  test("AC the writing job sits on the publish environment", () => {
    assert.match(workflow, /environment: publish/);
  });

  /**
   * hazard: a failure between the publish and the push leaves npm ahead of git, which needs a person. The step
   * says so and names the command, because the recovery is not guessable from `exit 1`.
   */
  test("AC a failed push names the recovery command", () => {
    assert.match(workflow, /npm has \$\{VERSION\} and main does not/);
    assert.match(workflow, /git push --atomic origin HEAD:main/);
  });
});

/**
 * The bundles the launcher runs.
 *
 * hazard: `--splitting` turns each entry into a small file plus shared chunks it imports by relative path. An
 * entry that lost its chunk is a hook that dies on the machine it fires on, and nothing else in this repository
 * would notice — the suite imports source, not `dist/`
 * ([/decisions/ad-098.md](/decisions/ad-098.md)).
 *
 * invariant: one flat `dist/<entry>.mjs` per source entrypoint, because that is what the launcher resolves and
 * what the hooks on every installed machine reach through it.
 */
describe("the built bundles", () => {
  const dist = join(repoRoot, "dist");

  function sources(): string[] {
    const names = [
      ...readdirSync(join(repoRoot, "src", "entrypoints")),
      ...readdirSync(join(repoRoot, "tools")),
    ]
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => name.replace(/\.ts$/, ""));
    return [...names, "tlc-cli"];
  }

  test("AC every entrypoint has a flat bundle the launcher can name", () => {
    if (!existsSync(dist)) {
      return; // a clone that has not built yet; CI builds before the gate
    }
    const missing = sources().filter((name) => !existsSync(join(dist, `${name}.mjs`)));

    assert.deepEqual(missing, [], "a source entrypoint with no bundle is a hook that cannot run under Node");
  });

  /** invariant: every chunk an entry imports exists. A relative import that resolves nowhere is a dead hook. */
  test("AC every chunk an entry imports is on disk", () => {
    if (!existsSync(dist)) {
      return;
    }
    const broken: string[] = [];
    for (const name of readdirSync(dist).filter((file) => file.endsWith(".mjs"))) {
      const text = readFileSync(join(dist, name), "utf8");
      for (const match of text.matchAll(/from\s*"(\.\/[^"]+\.mjs)"/g)) {
        const target = join(dist, match[1] as string);
        if (!existsSync(target)) {
          broken.push(`${name} → ${match[1]}`);
        }
      }
    }

    assert.deepEqual(broken, []);
  });

  /** why: hashed chunk names accumulate, so a stale one ships for ever unless the directory is replaced. */
  test("AC no chunk is orphaned by the entries that should reference it", () => {
    const chunks = join(dist, "chunks");
    if (!existsSync(chunks)) {
      return;
    }
    const referenced = new Set<string>();
    for (const name of readdirSync(dist).filter((file) => file.endsWith(".mjs"))) {
      for (const match of readFileSync(join(dist, name), "utf8").matchAll(/"\.\/chunks\/([^"]+)"/g)) {
        referenced.add(match[1] as string);
      }
    }
    for (const name of readdirSync(chunks).filter((file) => file.endsWith(".mjs"))) {
      for (const match of readFileSync(join(chunks, name), "utf8").matchAll(/"\.\/([^"/]+\.mjs)"/g)) {
        referenced.add(match[1] as string);
      }
    }

    const orphans = readdirSync(chunks).filter((name) => name.endsWith(".mjs") && !referenced.has(name));

    assert.deepEqual(orphans, [], "a chunk nothing imports is dead weight in every install");
  });
});
