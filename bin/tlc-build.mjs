#!/usr/bin/env node
/**
 * Build the Node-runnable ESM bundles under `dist/`.
 *
 * why this is not a shell script any more: the bash version ran only where bash runs, so `update` could not
 * rebuild a missing bundle on Windows — `spawnSync` cannot execute an extensionless bash file there — and CI had
 * to invoke it through `shell: bash` on all three legs. Nothing it does needs a shell
 * ([/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * why Bun only: `dist/` is committed and `check-dist-fresh` compares bytes, so the bundler is part of the
 * artefact. The bash version preferred Bun and fell back to esbuild, which means a contributor without Bun
 * produced different bytes for the same source — measured at 223,390 against 228,018 for one bundle
 * ([/decisions/ad-046.md](/decisions/ad-046.md)). One bundler is the only reproducible answer.
 *
 * invariant: what to build is derived from disk, one level deep. A hardcoded list silently stops building a new
 * entrypoint, and the missing bundle only surfaces when a hook fires on somebody's machine.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/**
 * why one level: `tools/dev/` holds the checks that validate *this* repository — a user's install has no
 * `src/core` of ours to validate — so the directory boundary is the whole declaration and nothing under it is
 * ever a bundle ([/decisions/ad-068.md](/decisions/ad-068.md)).
 */
function sourcesIn(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => ({ name: basename(entry.name, ".ts"), source: join(dir, entry.name) }));
}

/**
 * why one invocation with every entry: `--splitting` can only share a chunk between entries it sees together.
 * Built one at a time, each bundle inlined the whole core — measured, 24 bundles of ~257 KB each where more than
 * half of every one was byte-identical to its neighbour: 5.0 MB of `dist/` to carry 548 KB of distinct code
 * ([/decisions/ad-098.md](/decisions/ad-098.md)).
 *
 * invariant: the entry names stay flat and keep `.mjs`, because the launcher resolves `dist/<entry>.mjs` and the
 * hooks on every installed machine name the launcher. Chunks go in a subdirectory, so pruning an orphan entry
 * never has to tell the two apart.
 */
const CHUNK_DIR = "chunks";

function build(targets) {
  const result = spawnSync(
    "bun",
    [
      "build",
      "--target=node",
      "--format=esm",
      "--splitting",
      `--outdir=${dist}`,
      "--entry-naming",
      "[name].mjs",
      "--chunk-naming",
      `${CHUNK_DIR}/[name]-[hash].mjs`,
      ...targets.map((target) => target.source),
    ],
    { stdio: "inherit" },
  );
  if (result.error?.code === "ENOENT") {
    console.error("tlc-build: Bun is not on PATH, and it is the only bundler this builds with.");
    console.error("  curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

const targets = [
  ...sourcesIn(join(root, "src", "entrypoints")),
  ...sourcesIn(join(root, "tools")),
  { name: "tlc-cli", source: join(root, "bin", "tlc-cli.ts") },
];

mkdirSync(dist, { recursive: true });
console.log(`tlc-build → ${dist}`);

/**
 * hazard: chunk names carry a content hash, so a rebuild after a source change writes new ones and leaves the old
 * ones behind. Nothing references them and they ship anyway, growing the package with every build.
 *
 * invariant: the chunk directory is derived, so it is replaced rather than merged.
 */
rmSync(join(dist, CHUNK_DIR), { recursive: true, force: true });
build(targets);

// invariant: the launcher stays executable on a filesystem that tracks the bit. A no-op where it does not.
try {
  chmodSync(join(root, "bin", "tlc"), 0o755);
} catch {
  // a checkout on a filesystem without a mode bit is not a build failure
}

/**
 * hazard: a bundle whose source moved or was deleted is not rebuilt, so it is never diffed either — it stays in
 * `dist/` and ships. Deriving what to remove from the same disk that decides what to build closes that.
 */
const wanted = new Set(targets.map((target) => `${target.name}.mjs`));
let bundles = 0;
for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".mjs")) {
    continue;
  }
  if (wanted.has(entry.name)) {
    bundles += 1;
    continue;
  }
  console.log(`tlc-build: pruning ${entry.name} — no source`);
  rmSync(join(dist, entry.name), { force: true });
}

console.log(`tlc-build: ok (${bundles} bundles)`);
