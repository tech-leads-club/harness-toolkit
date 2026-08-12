import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// tools/check-screens.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
var repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
var RENDERER = /^export function (\w*(?:Text|Screen))\s*\(/gm;
function findRenderers(root, dirs) {
  const found = [];
  for (const dir of dirs) {
    for (const file of listFiles(join(root, dir))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(RENDERER)) {
        const renderer = match[1];
        if (renderer.endsWith("Screen")) {
          continue;
        }
        const body = bodyOf(source, match.index ?? 0);
        found.push({
          file: relative(root, file),
          renderer,
          styled: /\brender\(/.test(body) || /\bstyle\./.test(body)
        });
      }
    }
  }
  return found.sort((a, b) => `${a.file}${a.renderer}`.localeCompare(`${b.file}${b.renderer}`));
}
function bodyOf(source, from) {
  const next = source.indexOf(`
export `, from + 1);
  return source.slice(from, next === -1 ? source.length : next);
}
function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__test__" && entry !== "node_modules") {
        out.push(...listFiles(full));
      }
      continue;
    }
    if (full.endsWith(".ts") && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}
var SCREEN_DIRS = ["bin", "tools", "src/core/observability", "src/core/lesson"];
var UNSTYLED_BUDGET = 0;
function report(findings) {
  const unstyled = findings.filter((finding) => !finding.styled);
  const lines = [
    `check-screens: ${findings.length} screen renderer(s), ${unstyled.length} not yet on the shared renderer`
  ];
  for (const finding of unstyled) {
    lines.push(`  ${finding.file}  ${finding.renderer}`);
  }
  const ok = unstyled.length <= UNSTYLED_BUDGET;
  lines.push(ok ? "every screen is on the shared renderer or the shared palette" : `budget ${UNSTYLED_BUDGET} exceeded: a new screen must go through render() in src/platform/screen.ts`);
  return { text: lines.join(`
`), ok };
}
if (__require.main == __require.module) {
  const outcome = report(findRenderers(repoRoot, SCREEN_DIRS));
  console.log(outcome.text);
  process.exit(outcome.ok ? 0 : 1);
}
export {
  report,
  findRenderers,
  UNSTYLED_BUDGET,
  SCREEN_DIRS
};
