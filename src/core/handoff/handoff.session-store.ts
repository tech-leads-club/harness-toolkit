import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { updateJsonAtomic } from "../../platform/fs-atomic.ts";
import { handoffSessionsDir } from "../../platform/paths.ts";
import { isProcessAlive, type ProcessProbe } from "../../platform/process.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";
import { seal } from "../integrity/state-seal.ts";
import {
  HANDOFF_SESSION_SCHEMA,
  type HandoffProviderSlice,
  type HandoffSessionFile,
  isHandoffSessionFile,
} from "./handoff.types.ts";

/** why keyed by session alone: `sessionKey` is already unique per provider (every inbound mapper prefixes it
 * with the provider's own name), so a second key would only restate what the name already carries. */
export function handoffSessionPath(root: string, sessionKey: string): string {
  return join(handoffSessionsDir(root), `${sanitizeSegment(sessionKey)}.json`);
}

function handoffSessionLockPath(root: string, sessionKey: string): string {
  return `${handoffSessionPath(root, sessionKey)}.lock`;
}

export function readHandoffSessionFile(root: string, sessionKey: string): HandoffSessionFile | null {
  const path = handoffSessionPath(root, sessionKey);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isHandoffSessionFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * why the owner is restamped on every write: freshness is the whole point — a session that patches its own
 * slice is, by definition, alive right now, so `updated_at`/`pid`/`host` always reflect this process
 * ([/decisions/ad-122.md](/decisions/ad-122.md)).
 */
export function patchHandoffSession(
  root: string,
  provider: string,
  sessionKey: string,
  patch: Partial<HandoffProviderSlice>,
): Promise<HandoffSessionFile> {
  const path = handoffSessionPath(root, sessionKey);
  return updateJsonAtomic<HandoffSessionFile>(
    path,
    (current) => {
      const base = current && isHandoffSessionFile(current) ? current.slice : { updated_at: "" };
      const now = new Date().toISOString();
      return {
        schema: HANDOFF_SESSION_SCHEMA,
        owner: { pid: process.pid, host: hostname(), session_key: sessionKey, provider, updated_at: now },
        slice: { ...base, ...patch, updated_at: now },
      };
    },
    { lockPath: handoffSessionLockPath(root, sessionKey), afterWrite: seal },
  );
}

function readAllSessionFiles(root: string): Array<{ path: string; file: HandoffSessionFile }> {
  const dir = handoffSessionsDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  const out: Array<{ path: string; file: HandoffSessionFile }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const path = join(dir, entry.name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (isHandoffSessionFile(parsed)) {
        out.push({ path, file: parsed });
      }
    } catch {}
  }
  return out;
}

/** Every known session's file, across every provider — the operator's unfiltered diagnostic view. */
export function listHandoffSessionFiles(root: string): HandoffSessionFile[] {
  return readAllSessionFiles(root).map((entry) => entry.file);
}

export type PredecessorOptions = {
  thisHost?: string;
  probe?: ProcessProbe;
};

/**
 * The most-recently-updated *other* session of this provider whose process is confirmed gone — a legitimate
 * handoff. A live neighbour, however recent, is never a candidate: that is the one property this whole file
 * exists to guarantee ([/decisions/ad-122.md](/decisions/ad-122.md)).
 */
export function findDeadPredecessor(
  root: string,
  provider: string,
  sessionKey: string,
  options: PredecessorOptions = {},
): HandoffSessionFile | null {
  const candidates = readAllSessionFiles(root)
    .map((entry) => entry.file)
    .filter((file) => file.owner.provider === provider && file.owner.session_key !== sessionKey)
    .filter((file) => !isProcessAlive(file.owner.pid, file.owner.host, options.thisHost, options.probe));
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((latest, file) =>
    file.owner.updated_at > latest.owner.updated_at ? file : latest,
  );
}

/** The most-recently-updated session file for a *different* provider, regardless of liveness — session-start
 * cross-tool visibility ([/decisions/ad-039.md](/decisions/ad-039.md) precedent: informational, not continuity). */
export function latestSessionForProvider(root: string, provider: string): HandoffSessionFile | null {
  const candidates = readAllSessionFiles(root)
    .map((entry) => entry.file)
    .filter((file) => file.owner.provider === provider);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((latest, file) =>
    file.owner.updated_at > latest.owner.updated_at ? file : latest,
  );
}

export type PruneOptions = {
  now?: number;
  staleMs?: number;
  thisHost?: string;
  probe?: ProcessProbe;
};

const HANDOFF_SESSION_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * why bounded rather than immediate: a dead session's file is exactly what the *next* session inherits from.
 * Deleting it the moment its owner exits would remove the handoff before anyone reads it. Deleting it never
 * would grow the directory forever on a long-lived project. Seven days is long enough for a same-week restart
 * to still inherit, and bounded enough that it does not accumulate without limit.
 */
export function pruneDeadHandoffSessions(root: string, options: PruneOptions = {}): number {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? HANDOFF_SESSION_STALE_MS;
  let pruned = 0;
  for (const entry of readAllSessionFiles(root)) {
    const age = now - Date.parse(entry.file.owner.updated_at);
    if (Number.isNaN(age) || age < staleMs) {
      continue;
    }
    if (isProcessAlive(entry.file.owner.pid, entry.file.owner.host, options.thisHost, options.probe)) {
      continue;
    }
    try {
      unlinkSync(entry.path);
      pruned += 1;
    } catch {}
  }
  return pruned;
}
