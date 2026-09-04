import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectConfigPath } from "../../platform/paths.ts";

// why: mirrors core/lesson/lesson.garden.ts's lessonsMarkdownPath — providers cannot import core, so the join is duplicated.
export function opencodeLessonsSourcePath(root: string): string {
  return join(dirname(projectConfigPath(root)), "lessons.md");
}

export function opencodeConfigFilePath(root: string): string {
  return join(root, "opencode.json");
}

/**
 * why a config entry and not a rules file: `sessionStartContextReliable` is `false` on both generations
 * ([/decisions/ad-124.md](/decisions/ad-124.md)), so lessons cannot ride a session-start hook and need a durable
 * carrier the host reads on its own. opencode's rules reference documents an `instructions` array in
 * `opencode.json`, whose entries are combined with `AGENTS.md`.
 *
 * invariant: the path is project-relative, because that is the form the reference documents and the only form
 * that survives the repository being cloned somewhere else.
 */
const LESSONS_ENTRY = ".tlc/harness/lessons.md";

export type OpencodeLessonsView =
  | { status: "written"; path: string }
  | { status: "unchanged"; path: string }
  /** No lessons file yet — nothing to point at, and an empty pointer would be worse than none. */
  | { status: "absent" }
  /** hazard: a corrupted config breaks the operator's whole host, which is strictly worse than missing lessons. */
  | { status: "unparsed"; path: string };

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function applyOpencodeLessonsView(root: string): OpencodeLessonsView {
  if (!existsSync(opencodeLessonsSourcePath(root))) {
    return { status: "absent" };
  }
  const path = opencodeConfigFilePath(root);
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify({ instructions: [LESSONS_ENTRY] }, null, 2)}\n`, "utf8");
    return { status: "written", path };
  }

  const existing = readFileSync(path, "utf8");
  const document = parseObject(existing);
  if (document === null) {
    return { status: "unparsed", path };
  }

  const current = Array.isArray(document.instructions) ? document.instructions : [];
  if (current.includes(LESSONS_ENTRY)) {
    // invariant: idempotent. A second run must leave the file byte-identical, including whatever formatting the
    // operator's own editor left behind — which is why an already-present entry returns before any write.
    return { status: "unchanged", path };
  }

  // why append and never replace: every other entry is the operator's, and this file is theirs, not ours.
  const next = { ...document, instructions: [...current, LESSONS_ENTRY] };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { status: "written", path };
}

/**
 * The dispatcher's shape — a path when the pointer is in place, null when it is not.
 *
 * why stderr for the unparsed case: a provider module has no observability plane of its own, and returning null
 * alone would make a corrupted config look identical to "no lessons yet". The host surfaces a hook's stderr, so
 * one line there is the only channel that reaches the operator without a second copy of run.ts's recorder.
 */
export function renderOpencodeLessonsView(root: string): string | null {
  const result = applyOpencodeLessonsView(root);
  if (result.status === "unparsed") {
    process.stderr.write(
      `opencode lessons: ${result.path} is not valid JSON — left untouched, so lessons are not wired\n`,
    );
    return null;
  }
  return result.status === "absent" ? null : result.path;
}
