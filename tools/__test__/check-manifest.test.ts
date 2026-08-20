import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  checkManifest,
  type Manifest,
  missingBinTargets,
  npmPkgFix,
  npmSpawnOptions,
  report,
} from "../dev/check-manifest.ts";

const repoRoot = join(import.meta.dirname, "..", "..");

/**
 * A package root with a real manifest on disk, because the checker reads the file rather than an object — the
 * normaliser it hands off to needs a path.
 */
function packageRoot(manifest: Manifest & { name?: string; version?: string }, bins: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-manifest-test-"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "probe", version: "1.0.0", ...manifest }, null, 2)}\n`,
    "utf8",
  );
  for (const bin of bins) {
    const path = join(root, bin);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/usr/bin/env node\n", "utf8");
  }
  return root;
}

/** invariant: the identity normaliser, so a failure is the injected fault and never npm's opinion of the fixture. */
const unchanged = (path: string) => readFileSync(path, "utf8");

test("AC2 a manifest npm would rewrite is refused, naming the command that shows the diff", () => {
  const root = packageRoot({ bin: { probe: "bin/x.mjs" } }, ["bin/x.mjs"]);
  const rewritten = () => '{"name":"probe","version":"1.0.0","bin":{"probe":"bin/x.mjs"}}';

  const violations = checkManifest(root, rewritten);

  assert.deepEqual(
    violations.map((violation) => violation.rule),
    ["npm-would-correct"],
  );
  assert.match(violations[0]?.detail ?? "", /npm pkg fix/);
});

test("AC2 a bin target that does not exist is named with the key and the path", () => {
  const root = packageRoot({ bin: { probe: "bin/gone.mjs" } });

  const violations = checkManifest(root, unchanged);

  assert.deepEqual(violations, [
    { rule: "bin-target-missing", detail: "`probe` points at `bin/gone.mjs`, which does not exist" },
  ]);
});

test("a manifest npm leaves alone, with every bin present, is clean", () => {
  const root = packageRoot({ bin: { probe: "bin/x.mjs", other: "bin/y.mjs" } }, ["bin/x.mjs", "bin/y.mjs"]);

  assert.deepEqual(checkManifest(root, unchanged), []);
});

test("a manifest with no bin field is clean rather than an error", () => {
  assert.deepEqual(missingBinTargets(packageRoot({}), {}), []);
});

/**
 * why: this is the check that would have caught the shipped defect. `./bin/x.mjs` is what the manifest declared,
 * and npm dropped the entry on publish — so the oracle has to be npm's own normaliser, not a rule of ours that
 * guesses which spellings npm dislikes.
 */
test("AC3 npm's own normaliser rewrites a `./`-prefixed bin, which is the shipped defect", () => {
  const root = packageRoot({ bin: { probe: "./bin/x.mjs" } }, ["bin/x.mjs"]);

  const violations = checkManifest(root, npmPkgFix);

  assert.deepEqual(
    violations.map((violation) => violation.rule),
    ["npm-would-correct"],
  );
});

/** invariant: measuring must not fix. A gate that rewrites the file it checks reports a pass it caused. */
test("the normaliser leaves the manifest it was pointed at untouched", () => {
  const root = packageRoot({ bin: { probe: "./bin/x.mjs" } }, ["bin/x.mjs"]);
  const path = join(root, "package.json");
  const before = readFileSync(path, "utf8");

  npmPkgFix(path);

  assert.equal(readFileSync(path, "utf8"), before);
});

test("this repository's own manifest survives npm's normaliser unchanged", () => {
  assert.deepEqual(checkManifest(repoRoot), []);
});

/**
 * hazard: `npm` is `npm.cmd` on Windows and execFile does not consult PATHEXT, so the first version of this
 * checker threw `spawnSync npm ENOENT` on three tests — in Windows CI only, which is the one platform a
 * contributor here cannot run locally. The second version branched on the platform, which meant the branch that
 * mattered was the one nobody could run ([/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * invariant: one path, taken everywhere, so the tested behaviour is the shipped behaviour.
 */
test("the npm invocation goes through a shell on every platform", () => {
  assert.equal(npmSpawnOptions("/tmp/x").shell, true);
  assert.equal(npmSpawnOptions("/tmp/x").cwd, "/tmp/x");
});

test("report names every violation and says what held when there are none", () => {
  assert.equal(report([]).ok, true);
  assert.match(report([]).text, /npm publishes this manifest unchanged/);

  const printed = report([{ rule: "bin-target-missing", detail: "`probe` points at nothing" }]);
  assert.equal(printed.ok, false);
  assert.match(printed.text, /1 violation\(s\)/);
  assert.match(printed.text, /bin-target-missing/);
});
