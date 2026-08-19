import assert from "node:assert/strict";
import { test } from "node:test";
import { lockfilesFor, MANIFESTS, manifestFor } from "../supply-chain.catalog.ts";
import {
  declaredDependencies,
  dependencyOf,
  inspectSupplyChain,
  isUnpinned,
  supplyChainMessage,
} from "../supply-chain.service.ts";

const line = (file: string, at: number, text: string) => ({ file, line: at, text });

const PACKAGE_JSON = JSON.stringify({
  name: "demo",
  scripts: { build: "tsc" },
  devDependencies: { typescript: "^7.0.2", "left-pad": "latest" },
  dependencies: { serde: "1.0" },
});

const readDemo = () => PACKAGE_JSON;

test("AC1 a manifest that gained a dependency while no lockfile moved is unlocked", () => {
  const outcome = inspectSupplyChain({
    changedFiles: ["package.json"],
    added: [line("package.json", 12, '"typescript": "^7.0.2",')],
    readManifest: readDemo,
  });
  assert.equal(outcome.findings.length, 1);
  assert.equal(outcome.findings[0]?.kind, "unlocked");
  assert.equal(outcome.findings[0]?.detail.includes("package-lock.json"), true);
});

test("AC2 the same change with the lockfile moved yields nothing", () => {
  const outcome = inspectSupplyChain({
    changedFiles: ["package.json", "package-lock.json"],
    added: [line("package.json", 12, '"typescript": "^7.0.2",')],
    readManifest: readDemo,
  });
  assert.deepEqual(outcome.findings, []);
});

// why: a project on pnpm has locked just as firmly as one on npm, so any of the ecosystem's lockfiles counts.
test("an alternate lockfile counts as locked", () => {
  for (const lock of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
    const outcome = inspectSupplyChain({
      changedFiles: ["package.json", lock],
      added: [line("package.json", 12, '"typescript": "^7.0.2",')],
      readManifest: readDemo,
    });
    assert.deepEqual(outcome.findings, [], lock);
  }
});

test("AC3 a floating specifier is unpinned, and names the package", () => {
  const outcome = inspectSupplyChain({
    changedFiles: ["package.json", "package-lock.json"],
    added: [line("package.json", 13, '"left-pad": "latest"')],
    readManifest: readDemo,
  });
  assert.equal(outcome.findings.length, 1);
  assert.equal(outcome.findings[0]?.kind, "unpinned");
  assert.equal(outcome.findings[0]?.detail.includes("left-pad"), true);
});

test("AC4 a pinned or ranged specifier yields nothing", () => {
  for (const spec of ["^1.2.3", "~2.0", "1.4.5", ">=1.2 <2", "1.0"]) {
    assert.equal(isUnpinned(spec), false, spec);
  }
  for (const spec of ["latest", "*", "x", "", "main", ">=1", ">= 1.0"]) {
    assert.equal(isUnpinned(spec), true, spec);
  }
});

/**
 * hazard: this is the false positive the calibration found. Run against this repository's last eighty commits,
 * the textual shape read `"name": "harness-toolkit"` out of a rename commit as a dependency — and would read
 * every `scripts` entry the same way. A diff shows one line, so only the manifest's declared names can tell a
 * dependency from metadata ([/decisions/ad-075.md](/decisions/ad-075.md)).
 */
test("metadata and scripts are not dependencies, however much they look like one", () => {
  const outcome = inspectSupplyChain({
    changedFiles: ["package.json"],
    added: [
      line("package.json", 2, '"name": "harness-toolkit",'),
      line("package.json", 3, '"homepage": "https://example.com/readme",'),
      line("package.json", 5, '"build": "tsc",'),
    ],
    readManifest: readDemo,
  });
  assert.deepEqual(outcome.findings, []);
});

// invariant: an unreadable manifest yields nothing rather than guessing. A missed dependency is quieter than a
// refused rename, and the conservative direction is the one where honest work is not blocked.
test("an unreadable manifest produces no findings", () => {
  const outcome = inspectSupplyChain({
    changedFiles: ["package.json"],
    added: [line("package.json", 12, '"typescript": "^7.0.2",')],
    readManifest: () => null,
  });
  assert.deepEqual(outcome.findings, []);
});

test("AC6 a turn that changed no manifest produces nothing", () => {
  const outcome = inspectSupplyChain({
    changedFiles: ["src/a.ts", "README.md"],
    added: [line("src/a.ts", 1, "const a = 1;")],
    readManifest: () => {
      throw new Error("no manifest should be read");
    },
  });
  assert.deepEqual(outcome, { findings: [], unknownManifests: [] });
});

test("AC7 removing a dependency is not an addition", () => {
  const outcome = inspectSupplyChain({
    changedFiles: ["package.json"],
    added: [],
    readManifest: readDemo,
  });
  assert.deepEqual(outcome.findings, []);
});

test("each manifest shape reads its own dependency line", () => {
  assert.deepEqual(dependencyOf('  "typescript": "^7.0.2",', "json-object"), {
    name: "typescript",
    spec: "^7.0.2",
  });
  assert.deepEqual(dependencyOf('serde = "1.0"', "toml-table"), { name: "serde", spec: "1.0" });
  assert.deepEqual(dependencyOf("requests==2.31.0", "requirement"), {
    name: "requests",
    spec: "2.31.0",
  });
  assert.deepEqual(dependencyOf("flask", "requirement"), { name: "flask", spec: "" });
  assert.deepEqual(dependencyOf("require github.com/x/y v1.2.3", "directive"), {
    name: "github.com/x/y",
    spec: "v1.2.3",
  });
  assert.deepEqual(dependencyOf('gem "rails", "7.0"', "directive"), { name: "rails", spec: "7.0" });
  // invariant: a comment or a pip flag is not a requirement.
  assert.equal(dependencyOf("# pinned for CI", "requirement"), null);
  assert.equal(dependencyOf("-r base.txt", "requirement"), null);
});

test("declaredDependencies reads every dependency section and no other key", () => {
  const names = declaredDependencies(PACKAGE_JSON);
  assert.notEqual(names, null);
  assert.equal(names?.has("typescript"), true);
  assert.equal(names?.has("serde"), true);
  assert.equal(names?.has("build"), false, "a script is not a dependency");
  assert.equal(names?.has("name"), false, "metadata is not a dependency");
  assert.equal(declaredDependencies("not json"), null);
  assert.equal(declaredDependencies(null), null);
});

// why: recognised by filename, so adding an ecosystem is a row rather than a parser.
test("AC5 a filename the table does not carry is not a manifest", () => {
  assert.equal(manifestFor("package.json"), MANIFESTS[0]);
  assert.equal(manifestFor("apps/web/package.json")?.manifest, "package.json");
  assert.equal(manifestFor("deps.txt"), null);
  assert.equal(manifestFor("src/package.json.bak"), null);
});

test("every catalog row pairs a manifest with a lockfile it can actually check", () => {
  for (const entry of MANIFESTS) {
    assert.equal(entry.manifest.length > 0, true);
    const locks = lockfilesFor(entry);
    if (entry.lockfile === null) {
      assert.deepEqual(locks, [], `${entry.manifest} declares no lockfile`);
    } else {
      assert.equal(locks.includes(entry.lockfile), true, entry.manifest);
    }
  }
});

test("the message names both kinds separately and caps what it prints", () => {
  const many = Array.from({ length: 13 }, (_, index) => ({
    kind: index % 2 === 0 ? ("unlocked" as const) : ("unpinned" as const),
    file: "package.json",
    line: index,
    detail: `finding ${index}`,
  }));
  const text = supplyChainMessage(many);
  assert.equal(text.includes("13 way(s)"), true);
  assert.equal(text.includes("lockfile records what resolves"), true);
  assert.equal(text.includes("`latest` and `*` mean"), true);
  assert.equal(text.split("\n").filter((row) => row.includes("[un")).length, 10);
});
