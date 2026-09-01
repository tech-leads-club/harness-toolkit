import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateJsonAtomic } from "../../platform/fs-atomic.ts";
import { projectStateDir } from "../../platform/paths.ts";
import { seal } from "../integrity/state-seal.ts";
import { defaultHandoffFile, type HandoffFile, type HandoffShared, isHandoffFile } from "./handoff.types.ts";

export function handoffPath(root: string): string {
  return join(projectStateDir(root), "handoff.json");
}

function handoffLockPath(root: string): string {
  return `${handoffPath(root)}.lock`;
}

export function readHandoffFile(root: string): HandoffFile {
  const path = handoffPath(root);
  if (!existsSync(path)) {
    return defaultHandoffFile();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (isHandoffFile(parsed)) {
      return parsed;
    }
  } catch {}
  return defaultHandoffFile();
}

/** why shared only: the turn-scoped continuity slice moved to its own per-session file
 * ([/decisions/ad-122.md](/decisions/ad-122.md)) — nothing here is provider- or session-specific any more. */
export function patchHandoffShared(root: string, patch: Partial<HandoffShared>): Promise<HandoffFile> {
  return updateJsonAtomic<HandoffFile>(
    handoffPath(root),
    (current) => {
      const base = current && isHandoffFile(current) ? current : defaultHandoffFile();
      return {
        schema: base.schema,
        shared: { ...base.shared, ...patch, updated_at: new Date().toISOString() },
      };
    },
    { lockPath: handoffLockPath(root), afterWrite: seal },
  );
}
