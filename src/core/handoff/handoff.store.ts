import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateJsonAtomic } from "../../platform/fs-atomic.ts";
import { projectStateDir } from "../../platform/paths.ts";
import { seal } from "../integrity/state-seal.ts";
import {
  defaultHandoffFile,
  type HandoffFile,
  type HandoffProviderSlice,
  type HandoffShared,
  isHandoffFile,
} from "./handoff.types.ts";

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

export type HandoffPatch = {
  shared?: Partial<HandoffShared>;
  slice?: Partial<HandoffProviderSlice>;
};

export function patchHandoff(root: string, provider: string, patch: HandoffPatch): Promise<HandoffFile> {
  return updateJsonAtomic<HandoffFile>(
    handoffPath(root),
    (current) => {
      const base = current && isHandoffFile(current) ? current : defaultHandoffFile();
      const now = new Date().toISOString();
      const ownSlice = base.by_provider[provider] ?? { updated_at: now };
      return {
        schema: base.schema,
        shared: { ...base.shared, ...patch.shared, updated_at: now },
        by_provider: {
          ...base.by_provider,
          [provider]: { ...ownSlice, ...patch.slice, updated_at: now },
        },
      };
    },
    { lockPath: handoffLockPath(root), afterWrite: seal },
  );
}
