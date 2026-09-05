import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { projectConfigPath } from "../../platform/paths.ts";

// why: mirrors core/lesson/lesson.garden.ts's lessonsMarkdownPath — providers cannot import core, so the join is duplicated.
export function codexLessonsSourcePath(root: string): string {
  return join(dirname(projectConfigPath(root)), "lessons.md");
}

export function codexLessonsViewPath(root: string): string {
  return join(root, "AGENTS.md");
}

/** why posix separators: this line is read as a path by a model, and it is committed to a repository. */
function lessonsPointer(root: string): string {
  return relative(root, codexLessonsSourcePath(root)).split(sep).join("/");
}

/**
 * The durable route for a host that does not need one by default.
 *
 * `sessionStartContextReliable` is `true` here ([/decisions/ad-123.md](/decisions/ad-123.md)), so
 * `durableViewVerdict` writes nothing under the default `auto` — lessons ride the session-start hook. This view
 * exists for the operator who sets `syncRulesFile: "always"` (spec P4 AC7).
 *
 * invariant: a plain markdown pointer, never `@<path>`. Codex has no file-import syntax, so Claude's form would
 * be inert text dressed as a mechanism — and `AGENTS.md` is a file other tools read too, which makes a fake
 * directive in it worse than none.
 *
 * invariant: append-only and idempotent. `AGENTS.md` is the operator's own instructions file; a second run adds
 * nothing and nothing already in it is rewritten.
 */
export function renderCodexLessonsView(root: string): string | null {
  const sourcePath = codexLessonsSourcePath(root);
  if (!existsSync(sourcePath)) {
    return null;
  }

  const path = codexLessonsViewPath(root);
  const pointer = lessonsPointer(root);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(pointer)) {
    return path;
  }

  const block = `## Harness lessons\n\nRead \`${pointer}\` before changing code in this repository. It holds the ranked lessons the harness has recorded from gate failures.\n`;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const content = existing.length > 0 ? `${existing}${separator}\n${block}` : block;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}
