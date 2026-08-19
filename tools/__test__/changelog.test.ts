import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tagPrefixFor } from "../../src/core/release/release.version.ts";
import {
  acceptableRenderings,
  collectReleases,
  decisionFilesInRange,
  isShallow,
  pendingVersionArg,
  releaseTags,
  renderChangelog,
  withoutLeadingId,
} from "../dev/render-changelog.ts";

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function decision(root: string, id: string, title: string, migration?: string): void {
  const lines = ["---", 'type: "Decision"', `title: "${id.toUpperCase()} — ${title}"`];
  if (migration !== undefined) {
    lines.push(`migration: "${migration}"`);
  }
  lines.push("---", "", "# body", "");
  writeFileSync(join(root, "docs", "decisions", `${id}.md`), lines.join("\n"), "utf8");
}

/**
 * invariant: the fixture carries a `package.json` with a name, because the release tag is named after the package
 * and a repository without one has no releases to find. Fixtures that omitted it were the reason the tag glob
 * could be wrong and every test still pass ([/decisions/ad-087.md](/decisions/ad-087.md)).
 */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "changelog-"));
  mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  pkg(root, "0.0.0");
  return root;
}

test("with no tags every decision is unreleased", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "First");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: first"]);

    assert.deepEqual(releaseTags(root), []);
    const releases = collectReleases(root);
    assert.deepEqual(releases, [{ version: "Unreleased", decisions: ["ad-001.md"] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a decision belongs to the release that first contains it", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "First");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: first"]);
    git(root, ["tag", releaseTag("0.1.0")]);

    decision(root, "ad-002", "Second");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: second"]);
    git(root, ["tag", releaseTag("0.2.0")]);

    decision(root, "ad-003", "Third");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: third"]);

    assert.deepEqual(collectReleases(root), [
      { version: "Unreleased", decisions: ["ad-003.md"] },
      { version: "v0.2.0", decisions: ["ad-002.md"] },
      { version: "v0.1.0", decisions: ["ad-001.md"] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: the release PR bumps the version before the tag exists. If naming the pending version produced anything
// other than what tagging then produces, the first push after every release would fail its own --check.
test("naming the pending version equals what the tag produces", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "First");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: first"]);

    const inPr = renderChangelog(root, collectReleases(root, "v0.2.0"));
    git(root, ["tag", releaseTag("0.2.0")]);
    const afterTag = renderChangelog(root, collectReleases(root));

    assert.equal(inPr, afterTag);
    assert.match(afterTag, /## v0\.2\.0/);
    assert.doesNotMatch(afterTag, /Unreleased/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a migration note is called out, and a decision without one is not", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "Quiet one");
    decision(root, "ad-002", "Loud one", "Re-run the installer once.");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: both"]);

    const rendered = renderChangelog(root, collectReleases(root));
    assert.match(
      rendered,
      /- \*\*AD-002\*\* — Loud one\n {2}- \*\*Needs your action:\*\* Re-run the installer once\./,
    );
    assert.match(rendered, /- \*\*AD-001\*\* — Quiet one\n- /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file that is not a decision record is not a changelog entry", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "First");
    writeFileSync(join(root, "docs", "decisions", "index.md"), "# index\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "docs: both"]);

    assert.deepEqual(decisionFilesInRange(root, "HEAD"), ["ad-001.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the id is not printed twice when the title already carries it", () => {
  assert.equal(
    withoutLeadingId("AD-031", "AD-031 — The decisions are the changelog"),
    "The decisions are the changelog",
  );
  assert.equal(
    withoutLeadingId("AD-031", "The decisions are the changelog"),
    "The decisions are the changelog",
  );
});

test("--release needs a version and normalises the v", () => {
  assert.equal(pendingVersionArg(["node", "x", "--release", "1.2.0"]), "v1.2.0");
  assert.equal(pendingVersionArg(["node", "x", "--release", "v1.2.0"]), "v1.2.0");
  assert.equal(pendingVersionArg(["node", "x"]), undefined);
  assert.throws(() => pendingVersionArg(["node", "x", "--release", "--check"]), /needs a version/);
});

// hazard: the unreleased bucket read committed adds, so the commit that introduces a decision record could not
// contain its own changelog entry and the gate failed until a second commit regenerated. A record counts from the
// moment it is on disk.
test("a decision record that is not committed yet is already unreleased", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "Committed");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: first"]);
    decision(root, "ad-002", "Staged but not committed");

    assert.deepEqual(collectReleases(root), [
      { version: "Unreleased", decisions: ["ad-001.md", "ad-002.md"] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a released decision does not reappear as unreleased", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "Shipped");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: first"]);
    git(root, ["tag", releaseTag("0.1.0")]);
    decision(root, "ad-002", "Fresh");

    assert.deepEqual(collectReleases(root), [
      { version: "Unreleased", decisions: ["ad-002.md"] },
      { version: "v0.1.0", decisions: ["ad-001.md"] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shallow checkout is reported as unreadable, not as drift", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "First");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: first"]);
    assert.equal(isShallow(root), false);

    const shallow = mkdtempSync(join(tmpdir(), "changelog-shallow-"));
    rmSync(shallow, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${root}`, shallow], { stdio: "ignore" });
    try {
      assert.equal(isShallow(shallow), true);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: this used to write only `version`, and the tags below were bare `v0.1.0`. That is a tag scheme this
 * repository has never used — every real tag is `harness-toolkit-v…` — so the fixtures agreed with the bug
 * instead of catching it ([/decisions/ad-087.md](/decisions/ad-087.md)).
 */
const FIXTURE_PACKAGE = "@tech-leads-club/harness-toolkit";

function pkg(root: string, version: string): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: FIXTURE_PACKAGE, version }), "utf8");
}

/** The tag a release actually gets, so a fixture cannot pass under a scheme the product does not write. */
function releaseTag(version: string): string {
  return `${tagPrefixFor(FIXTURE_PACKAGE)}${version}`;
}

// hazard: ci.yml and release.yml both fire on a push to main and run in parallel, so on the commit that merges a
// release PR the gate reads a CHANGELOG naming v0.2.0 while the tag is still being created in the other workflow.
// Without this the gate would fail on every release, on a file that is already correct.
test("the merge commit of a release PR passes before its tag exists", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "Shipped");
    pkg(root, "0.1.0");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: first"]);
    git(root, ["tag", releaseTag("0.1.0")]);

    decision(root, "ad-002", "Next");
    // the release PR bumped the version; the tag does not exist yet
    pkg(root, "0.2.0");
    const inPr = renderChangelog(root, collectReleases(root, "v0.2.0"));

    assert.ok(acceptableRenderings(root).includes(inPr), "the pending rendering must be accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("once the tag exists the same file still passes, and only that file does", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "Shipped");
    pkg(root, "0.2.0");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: first"]);

    const inPr = renderChangelog(root, collectReleases(root, "v0.2.0"));
    git(root, ["tag", releaseTag("0.2.0")]);

    const accepted = acceptableRenderings(root);
    assert.equal(accepted.length, 1, "the tolerance closes once the tag lands");
    assert.ok(accepted.includes(inPr), "the document the PR produced is what the tag produces");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale changelog is rejected in both states", () => {
  const root = repo();
  try {
    decision(root, "ad-001", "Shipped");
    pkg(root, "0.2.0");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: first"]);

    const stale = "# Changelog\n\n## Unreleased\n\n- **AD-000** — something else\n";
    assert.ok(!acceptableRenderings(root).includes(stale), "before the tag");
    git(root, ["tag", releaseTag("0.2.0")]);
    assert.ok(!acceptableRenderings(root).includes(stale), "after the tag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
