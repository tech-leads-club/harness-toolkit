import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export type ScreenFinding = { file: string; renderer: string; styled: boolean };

const RENDERER = /^export function (\w*(?:Text|Screen))\s*\(/gm;

// why: a renderer that assembles its own strings decides its own spacing and colour, which is how screens drift
// apart. Going through `render` is what makes the standard structural rather than a habit
// ([/decisions/ad-063.md](/decisions/ad-063.md)).
export function findRenderers(root: string, dirs: readonly string[]): ScreenFinding[] {
  const found: ScreenFinding[] = [];
  for (const dir of dirs) {
    for (const file of listFiles(join(root, dir))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(RENDERER)) {
        const renderer = match[1] as string;
        if (renderer.endsWith("Screen")) {
          continue;
        }
        const body = bodyOf(source, match.index ?? 0);
        found.push({
          file: relative(root, file),
          renderer,
          styled: /\brender\(/.test(body) || /\bstyle\./.test(body),
        });
      }
    }
  }
  return found.sort((a, b) => `${a.file}${a.renderer}`.localeCompare(`${b.file}${b.renderer}`));
}

function bodyOf(source: string, from: number): string {
  const next = source.indexOf("\nexport ", from + 1);
  return source.slice(from, next === -1 ? source.length : next);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
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

export const SCREEN_DIRS = ["bin", "tools", "src/core/observability", "src/core/lesson"] as const;

/**
 * invariant: a ratchet, not a wall. Converting every screen at once would be one unreviewable change, and a
 * checker that merely allowed a list would hide the remainder. The count may only fall.
 */
/**
 * invariant: zero. Every human surface goes through the shared renderer or the shared palette, so a new screen
 * that does neither fails the gate rather than drifting quietly.
 */
export const UNSTYLED_BUDGET = 0;

export function report(findings: readonly ScreenFinding[]): { text: string; ok: boolean } {
  const unstyled = findings.filter((finding) => !finding.styled);
  const lines = [
    `check-screens: ${findings.length} screen renderer(s), ${unstyled.length} not yet on the shared renderer`,
  ];
  for (const finding of unstyled) {
    lines.push(`  ${finding.file}  ${finding.renderer}`);
  }
  const ok = unstyled.length <= UNSTYLED_BUDGET;
  lines.push(
    ok
      ? "every screen is on the shared renderer or the shared palette"
      : `budget ${UNSTYLED_BUDGET} exceeded: a new screen must go through render() in src/platform/screen.ts`,
  );
  return { text: lines.join("\n"), ok };
}

if (import.meta.main) {
  const outcome = report(findRenderers(repoRoot, SCREEN_DIRS));
  console.log(outcome.text);
  process.exit(outcome.ok ? 0 : 1);
}
