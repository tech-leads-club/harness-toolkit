import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { projectConfigPath } from "../../platform/paths.ts";

// why: mirrors core/lesson/lesson.garden.ts's lessonsMarkdownPath — providers cannot import core, so the join is duplicated.
export function vscodeLessonsSourcePath(root: string): string {
  return join(dirname(projectConfigPath(root)), "lessons.md");
}

export function vscodeLessonsViewPath(root: string): string {
  return join(root, ".github", "copilot-instructions.md");
}

/** why posix separators: this line is read as a path by a model, and it is committed to a repository. */
function lessonsPointer(root: string): string {
  return relative(root, vscodeLessonsSourcePath(root)).split(sep).join("/");
}

/**
 * The durable route for a host that does not need one by default.
 *
 * `sessionStartContextReliable` is `true` here ([/decisions/ad-125.md](/decisions/ad-125.md)), so
 * `durableViewVerdict` writes nothing under the default `auto` — lessons ride the session-start hook. This view
 * exists for the operator who sets `syncRulesFile: "always"` and wants the pointer in a file the host reads
 * whether or not the hook fired (spec P4 AC7).
 *
 * why a plain markdown pointer and not `@<path>`: design §9 carried Claude's import syntax across. Nothing in
 * VS Code's or GitHub's documentation describes an import syntax for `copilot-instructions.md`, so an `@` line
 * would be inert text that reads as a mechanism. A sentence naming the file is inert text that reads as what it
 * is, and the model can open the path.
 *
 * invariant: append-only and idempotent. This file is the operator's — it holds their own instructions — so a
 * second run adds nothing and nothing already in it is rewritten.
 */
export function renderVSCodeLessonsView(root: string): string | null {
  const sourcePath = vscodeLessonsSourcePath(root);
  if (!existsSync(sourcePath)) {
    return null;
  }

  const path = vscodeLessonsViewPath(root);
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
