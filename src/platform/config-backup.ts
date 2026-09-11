import { writeFileSync } from "node:fs";

// why: every editor wiring writer (Cursor, Codex, Claude, OpenCode, VS Code) rewrites a file that may hold
// content from another tool. A timestamped backup of what was there right before the rewrite is the
// recovery path if a merge ever gets a foreign entry wrong — shared here so all five write the same
// shape instead of drifting.
export function backupPathFor(targetPath: string, now: () => Date = () => new Date()): string {
  return `${targetPath}.${now().toISOString().replace(/[:.]/g, "-")}.bak`;
}

export function backupBeforeWrite(targetPath: string, existingText: string, now?: () => Date): void {
  writeFileSync(backupPathFor(targetPath, now), existingText, "utf8");
}