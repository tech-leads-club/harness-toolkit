import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  DEFAULT_CONFIG,
  parseFrontmatter,
  runBundleChecks,
  type Violation,
} from "../dev/check-docs-bundle.ts";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "check-docs-bundle-"));
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function checks(root: string) {
  return runBundleChecks({ root, ...DEFAULT_CONFIG });
}

function rulesOf(violations: Violation[]): string[] {
  return violations.map((v) => v.rule);
}

describe("parseFrontmatter", () => {
  test("parses scalar and array fields", () => {
    const { frontmatter, error } = parseFrontmatter(
      '---\ntype: Concept\ntitle: "Example"\ndescription: An example doc\ntags: [a, b, c]\ntimestamp: "2026-07-29"\n---\n\nbody\n',
    );
    assert.equal(error, null);
    assert.deepEqual(frontmatter, {
      type: "Concept",
      title: "Example",
      description: "An example doc",
      tags: ["a", "b", "c"],
      timestamp: "2026-07-29",
    });
  });

  test("returns an error when there is no frontmatter block", () => {
    const { frontmatter, error } = parseFrontmatter("# Just a heading\n");
    assert.equal(frontmatter, null);
    assert.ok(error);
  });

  test("returns an error when a frontmatter line has no colon", () => {
    const { frontmatter, error } = parseFrontmatter("---\ntype Concept\n---\nbody\n");
    assert.equal(frontmatter, null);
    assert.ok(error?.includes("unparseable"));
  });
});

describe("runBundleChecks — clean bundle", () => {
  test("passes with zero violations on a fully conforming bundle", () => {
    const root = fixtureRoot();
    write(
      root,
      "docs/index.md",
      '---\nokf_version: "0.1"\ntitle: "Index"\ndescription: "Bundle index"\ntags: [index]\ntimestamp: "2026-07-29"\n---\n\n# Index\n',
    );
    write(
      root,
      "docs/log.md",
      '---\ntitle: "Log"\ndescription: "Changelog"\ntags: [log]\ntimestamp: "2026-07-29"\n---\n\n## 2026-07-29\n\n- entry\n',
    );
    write(
      root,
      "docs/concepts.md",
      '---\ntype: Concept\ntitle: "Concepts"\ndescription: "Core concepts"\ntags: [concept]\ntimestamp: "2026-07-29"\n---\n\n# Concepts\n',
    );
    write(
      root,
      "docs/decisions/ad-001.md",
      '---\ntype: Decision\ntitle: "AD-001"\ndescription: "A decision"\ntags: [decision]\ntimestamp: "2026-07-29"\n---\n\n# AD-001\n',
    );
    assert.deepEqual(checks(root), []);
    rmSync(root, { recursive: true, force: true });
  });

  test("tolerates a missing docs directory without throwing", () => {
    const root = fixtureRoot();
    assert.doesNotThrow(() => checks(root));
    assert.deepEqual(checks(root), []);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("runBundleChecks — seeded violations", () => {
  test("flags a non-reserved doc with no frontmatter block at all", () => {
    const root = fixtureRoot();
    write(root, "docs/architecture.md", "# Architecture\n\nno frontmatter here\n");
    const violations = checks(root);
    assert.deepEqual(rulesOf(violations), ["frontmatter-parse"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("flags a missing type field", () => {
    const root = fixtureRoot();
    write(
      root,
      "docs/architecture.md",
      '---\ntitle: "Architecture"\ndescription: "desc"\ntags: [x]\ntimestamp: "2026-07-29"\n---\n\nbody\n',
    );
    const violations = checks(root);
    assert.deepEqual(rulesOf(violations), ["missing-type"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("flags a type outside the closed OKF vocabulary", () => {
    const root = fixtureRoot();
    write(
      root,
      "docs/architecture.md",
      '---\ntype: Essay\ntitle: "Architecture"\ndescription: "desc"\ntags: [x]\ntimestamp: "2026-07-29"\n---\n\nbody\n',
    );
    const violations = checks(root);
    assert.deepEqual(rulesOf(violations), ["invalid-type"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("flags missing title/description/tags/timestamp individually", () => {
    const root = fixtureRoot();
    write(root, "docs/architecture.md", "---\ntype: Concept\n---\n\nbody\n");
    const violations = checks(root);
    assert.deepEqual(rulesOf(violations), [
      "missing-field",
      "missing-field",
      "missing-field",
      "missing-field",
    ]);
    assert.ok(violations.every((v) => v.rule === "missing-field"));
    rmSync(root, { recursive: true, force: true });
  });

  test("flags an empty tags array as missing", () => {
    const root = fixtureRoot();
    write(
      root,
      "docs/architecture.md",
      '---\ntype: Concept\ntitle: "t"\ndescription: "d"\ntags: []\ntimestamp: "2026-07-29"\n---\n\nbody\n',
    );
    const violations = checks(root);
    assert.deepEqual(rulesOf(violations), ["missing-field"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("flags docs/index.md missing okf_version", () => {
    const root = fixtureRoot();
    write(
      root,
      "docs/index.md",
      '---\ntitle: "Index"\ndescription: "d"\ntags: [x]\ntimestamp: "2026-07-29"\n---\n\nbody\n',
    );
    const violations = checks(root);
    assert.deepEqual(rulesOf(violations), ["index-missing-okf-version"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("flags docs/log.md with no ISO 8601 heading", () => {
    const root = fixtureRoot();
    write(
      root,
      "docs/log.md",
      '---\ntitle: "Log"\ndescription: "d"\ntags: [x]\ntimestamp: "2026-07-29"\n---\n\nno dated entries\n',
    );
    const violations = checks(root);
    assert.deepEqual(rulesOf(violations), ["log-not-dated"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("checks nested files under docs/providers and docs/decisions", () => {
    const root = fixtureRoot();
    write(root, "docs/providers/cursor.md", "no frontmatter\n");
    const violations = checks(root);
    assert.deepEqual(
      violations.map((v) => v.file),
      [join("docs", "providers", "cursor.md")],
    );
    rmSync(root, { recursive: true, force: true });
  });
});

// hazard: a decision announced as needing action that then shows nothing is worse than one that never claimed it —
// the operator reads the heading, finds no instruction, and learns to skip the heading
// ([/decisions/ad-031.md](/decisions/ad-031.md)).
test("flags a migration note that is present but empty", () => {
  const root = fixtureRoot();
  write(
    root,
    "docs/architecture.md",
    '---\ntype: Concept\ntitle: "Architecture"\ndescription: "desc"\nmigration: ""\ntags: [x]\ntimestamp: "2026-07-29"\n---\n\nbody\n',
  );
  assert.deepEqual(rulesOf(checks(root)), ["empty-migration"]);
  rmSync(root, { recursive: true, force: true });
});

// why: optional. Requiring it on every document would produce "no migration needed" on the large majority and train
// a reader to skip the field.
test("a document with no migration note passes", () => {
  const root = fixtureRoot();
  write(
    root,
    "docs/architecture.md",
    '---\ntype: Concept\ntitle: "Architecture"\ndescription: "desc"\ntags: [x]\ntimestamp: "2026-07-29"\n---\n\nbody\n',
  );
  assert.deepEqual(rulesOf(checks(root)), []);
  rmSync(root, { recursive: true, force: true });
});

test("a document with a real migration note passes", () => {
  const root = fixtureRoot();
  write(
    root,
    "docs/architecture.md",
    '---\ntype: Concept\ntitle: "Architecture"\ndescription: "desc"\nmigration: "Change X to Y."\ntags: [x]\ntimestamp: "2026-07-29"\n---\n\nbody\n',
  );
  assert.deepEqual(rulesOf(checks(root)), []);
  rmSync(root, { recursive: true, force: true });
});
