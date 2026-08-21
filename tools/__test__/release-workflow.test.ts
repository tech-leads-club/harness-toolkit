import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  /**
   * why the step is named `Stage the release on npm`: the registry step is a *staging* now, so the ordering claim is
   * the same and the name it asserts moved ([/decisions/ad-102.md](/decisions/ad-102.md)).
   */
  test("AC npm publish precedes the push, and the push precedes the GitHub release", () => {
    const publish = workflow.indexOf("- name: Publish to npm");
    const push = workflow.indexOf("- name: Push the commit and the tag");
    const release = workflow.indexOf("- name: Create the GitHub release");

    assert.ok(publish > 0 && push > 0 && release > 0, "all three steps must exist");
    assert.ok(
      publish < push,
      "reaching the registry after the push is the ordering that stranded three tags",
    );
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

  /**
   * hazard: the check above this one asserted that every bundle *imports* — and a bundle can import fine while
   * running somebody else's program. Splitting put `bin/tlc-cli.ts`'s module body in a shared chunk, its
   * `import.meta.main` guard evaluated true inside that chunk, and every entry that reaches the CLI ran the CLI's
   * `main`. `tlc harness install` printed `unknown:` and installed nothing, and it shipped as 0.3.2 because
   * "it imports" was the whole test ([/decisions/ad-098.md](/decisions/ad-098.md)).
   *
   * invariant: exactly one bundle answers as the CLI. Any other one printing the CLI's usage means a guard fired
   * in the wrong program.
   */
  test("AC only the CLI bundle behaves like the CLI", () => {
    if (!existsSync(dist)) {
      return;
    }
    const scratch = mkdtempSync(join(tmpdir(), "tlc-bundle-probe-"));
    const impostors: string[] = [];
    try {
      for (const name of readdirSync(dist).filter((file) => file.endsWith(".mjs"))) {
        if (name === "tlc-cli.mjs") {
          continue;
        }
        const result = spawnSync(process.execPath, [join(dist, name)], {
          encoding: "utf8",
          input: "",
          timeout: 20_000,
          env: {
            ...process.env,
            TLC_HOME: scratch,
            TLC_PROJECT_DIR: scratch,
            CLAUDE_PROJECT_DIR: scratch,
          },
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        if (output.includes("usage: tlc harness <status|")) {
          impostors.push(name);
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    assert.deepEqual(impostors, [], "these bundles ran the CLI instead of themselves");
  });

  /** invariant: and the CLI bundle does answer as the CLI, or the assertion above would pass on 24 dead files. */
  test("AC the CLI bundle is the one that answers as the CLI", () => {
    if (!existsSync(join(dist, "tlc-cli.mjs"))) {
      return;
    }
    const result = spawnSync(process.execPath, [join(dist, "tlc-cli.mjs"), "harness", "help"], {
      encoding: "utf8",
      timeout: 20_000,
    });

    assert.match(`${result.stdout ?? ""}${result.stderr ?? ""}`, /harness/);
  });
});

/**
 * hazard: every test in this repository runs against the working tree, which is not the package. Three install
 * defects reached operators through that gap — 0.3.0 installed nothing, 0.3.2 shipped bundles where every entry
 * answered as the CLI, and 0.4.0 left `tlc` off `PATH` ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
describe("the packed artefact is verified before the irreversible step", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

  test("the release job runs the clean-room verification", () => {
    assert.match(workflow, /node tools\/dev\/verify-package\.mjs/);
  });

  /**
   * invariant: before `npm publish`. After it the version is on the registry for good, so a verification that runs
   * later is a report rather than a gate.
   */
  test("and runs it before the version reaches the registry", () => {
    /**
     * why the step name and not the command string: the command appears in prose above the step that runs it — a
     * comment explaining the recovery when the push after it fails. Matching the loose string put the registry step
     * "before" the verification and failed on a correct workflow.
     */
    const verify = workflow.indexOf("- name: Verify the packed artefact");
    const registry = workflow.indexOf("- name: Publish to npm");

    assert.ok(verify > 0 && registry > 0, "both steps must exist");
    assert.ok(verify < registry, "verification must precede anything reaching the registry");
  });

  /** why asserted: the payload list is the half that runs before anything is installed, and it is easy to gut. */
  test("the verification asserts the payload and drives the installed command", () => {
    const script = readFileSync(join(repoRoot, "tools", "dev", "verify-package.mjs"), "utf8");

    for (const required of ["package/bin/tlc", "package/dist/tool-before.mjs", "tlc harness doctor"]) {
      assert.ok(script.includes(required), `the verification no longer checks ${required}`);
    }
  });
});

/**
 * `latest` is the only tag npm treats specially — a bare `npm i` resolves it — so it is the switch that decides what
 * a new machine gets. Releasing straight onto it leaves no window between "published" and "everybody gets it":
 * 0.4.2 shipped a defect that 0.4.3 fixed minutes later, and nothing was wrong with the gate
 * ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
/**
 * A release must not become everybody's install by itself, and it must not need a credential in this repository to
 * have that property.
 *
 * hazard: the first shape of this published to a `next` dist-tag and promoted with `npm dist-tag add`, which needs
 * an automation token — trusted publishing covers `npm publish` and `npm stage publish` and nothing else. It also
 * made the version installable, which is not what "not live yet" should mean
 * ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
/**
 * A release is fully automated and holds no credential: trusted publishing mints a short-lived OIDC token per run
 * and npm checks it against the registered publisher, so there is no stored secret and nothing to rotate.
 *
 * hazard: two shapes were tried before this. A `next` dist-tag needs an automation token, because trusted publishing
 * covers `npm publish` and not `npm dist-tag`. `npm stage publish` is tokenless but deliberately cannot be finished
 * by a workflow, which converts every release into a manual step. Neither bought safety the gate does not already
 * provide ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
describe("the release publishes without a credential and without a human", () => {
  const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

  function commands(): string[] {
    return release.split("\n").filter((line) => /^\s*run:/.test(line) || /^\s{8,}npm /.test(line));
  }

  test("it publishes", () => {
    assert.ok(
      commands().some((line) => /npm publish\s*$/.test(line)),
      commands().join("\n"),
    );
  });

  /** invariant: no dist-tag is executed anywhere — moving one needs a token this repository does not hold. */
  test("and moves no dist-tag", () => {
    assert.deepEqual(
      commands().filter((line) => line.includes("dist-tag")),
      [],
    );
  });

  /** invariant: no staging either, because a step no workflow can finish is a manual release wearing automation. */
  test("and stages nothing", () => {
    assert.deepEqual(
      commands().filter((line) => line.includes("npm stage")),
      [],
    );
  });

  /**
   * invariant: the OIDC identity is what publishes, so the job must ask for it. Without `id-token: write` npm falls
   * back to looking for a token, and there is none.
   */
  /**
   * hazard: this matched `id-token: write` anywhere in the file, and the string also appears in a comment
   * explaining it — so deleting the real permission left the assertion green. Scoped to the job that publishes
   * ([/decisions/ad-102.md](/decisions/ad-102.md)).
   */
  test("the publishing job asks for the OIDC identity", () => {
    const job = release.slice(release.indexOf("\n  release:"), release.indexOf("- name: Publish to npm"));

    assert.match(job, /^\s+id-token: write$/m, job.slice(0, 400));
  });

  /**
   * invariant: `NODE_AUTH_TOKEN` and friends must appear nowhere. A token in this workflow would be a stored
   * credential in a repository whose whole release story is that it has none.
   */
  test("and no token is referenced anywhere in it", () => {
    for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "npm_config__authToken"]) {
      assert.ok(!release.includes(name), `${name} appears in the release workflow`);
    }
  });

  /** why asserted here: provenance is what makes the tokenless publish auditable after the fact. */
  test("the package asks for provenance and public access", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      publishConfig?: { access?: string; provenance?: boolean };
    };

    assert.equal(manifest.publishConfig?.provenance, true);
    assert.equal(manifest.publishConfig?.access, "public");
  });
});
