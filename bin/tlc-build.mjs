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

function buildOne(source, out) {
  const result = spawnSync(
    "bun",
    ["build", "--target=node", "--format=esm", `--outfile=${out}`, source],
    { stdio: "inherit" },
  );
  if (result.error?.code === "ENOENT") {
    console.error("tlc-build: Bun is not on PATH, and dist/ is committed so the bundler is part of the artefact.");
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
for (const target of targets) {
  buildOne(target.source, join(dist, `${target.name}.mjs`));
}

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
