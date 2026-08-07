import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectReleases,
  decisionFilesInRange,
  pendingVersionArg,
  releaseTags,
  renderChangelog,
  withoutLeadingId,
} from "../render-changelog.ts";

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

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "changelog-"));
  mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
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
    git(root, ["tag", "v0.1.0"]);

    decision(root, "ad-002", "Second");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "feat: second"]);
    git(root, ["tag", "v0.2.0"]);

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
    git(root, ["tag", "v0.2.0"]);
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
