import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { changesBehaviour, decidingScope, violations } from "../dev/check-scopes.ts";

/**
 * AC — an inert scope claims the change cannot reach anyone who installed the package. `fix(gate)` on
 * `tools/doctor.ts` is that claim being false, and it happened ([/decisions/ad-103.md](/decisions/ad-103.md)).
 */
describe("decidingScope", () => {
  test("a releasing type with an inert scope is what this check is about", () => {
    assert.equal(decidingScope("fix(gate): something"), "gate");
    assert.equal(decidingScope("feat(ci): something"), "ci");
    assert.equal(decidingScope("perf(release): something"), "release");
  });

  /**
   * invariant: the release bot's own commit stays inert — that is what stops the pipeline releasing itself for
   * ever — so a type that never releases has no scope worth reading.
   */
  test("a type that never releases is not a scope question at all", () => {
    assert.equal(decidingScope("chore(release): 0.4.3"), null);
    assert.equal(decidingScope("docs(rules): explain it"), null);
    assert.equal(decidingScope("build(gate): rewire"), null);
  });

  test("a subject that is not conventional at all decides nothing", () => {
    assert.equal(decidingScope("wip"), null);
  });

  test("a releasing type with no scope is never inert", () => {
    assert.equal(decidingScope("fix: something"), null);
  });
});

describe("changesBehaviour", () => {
  /** invariant: documentation ships and changes no behaviour, so touching it is never evidence against a scope. */
  test("documentation is exempt", () => {
    assert.equal(changesBehaviour("README.md"), false);
    assert.equal(changesBehaviour("docs/concepts.md"), false);
    assert.equal(changesBehaviour("skills/harness-init/SKILL.md"), false);
  });

  test("code is not", () => {
    assert.equal(changesBehaviour("tools/doctor.ts"), true);
    assert.equal(changesBehaviour("src/core/core.facade.ts"), true);
    assert.equal(changesBehaviour("capabilities/catalog.json"), true);
  });
});

/**
 * The range walk, against a real repository rather than a stub: the defect this check exists for was invisible to
 * every assertion that read source instead of running it ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
describe("violations", () => {
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "tlc-scopes-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(root, "seed"), "seed", "utf8");
    git("add", "-A");
    git("commit", "-q", "-m", "chore: seed");
    return root;
  }

  function commit(root: string, subject: string, path: string): void {
    writeFileSync(join(root, path), subject, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", subject], { cwd: root });
  }

  const published = new Set(["ships.ts", "README.md"]);

  test("an inert scope over a shipped file is reported, with the file named", () => {
    const root = repo();
    commit(root, "fix(gate): quietly changes what operators run", "ships.ts");

    const found = violations("HEAD~1..HEAD", published, root);

    assert.equal(found.length, 1);
    assert.equal(found[0]?.scope, "gate");
    assert.deepEqual(found[0]?.paths, ["ships.ts"]);
  });

  test("the same scope over a file the package does not ship is fine", () => {
    const root = repo();
    commit(root, "fix(gate): plumbing only", "not-shipped.ts");

    assert.deepEqual(violations("HEAD~1..HEAD", published, root), []);
  });

  test("and over documentation it ships, also fine", () => {
    const root = repo();
    commit(root, "fix(docs): a typo", "README.md");

    assert.deepEqual(violations("HEAD~1..HEAD", published, root), []);
  });

  test("an empty range reports nothing rather than failing", () => {
    assert.deepEqual(violations("HEAD..HEAD", published, repo()), []);
  });
});
