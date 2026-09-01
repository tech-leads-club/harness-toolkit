import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { updateJsonAtomic } from "../../platform/fs-atomic.ts";
import { handoffSessionsDir } from "../../platform/paths.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";
import { seal, sealPath, shouldInject, verifySeal } from "../integrity/state-seal.ts";
import { isSessionLive } from "../presence/presence.service.ts";
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

const EMPTY_SLICE: HandoffProviderSlice = { updated_at: "" };

/**
 * why: clearing a field is omitting its key (JSON drops `undefined`), indistinguishable from never written —
 * re-merging a predecessor on every read cannot tell those apart, so a clear kept resurfacing. Copying it in
 * once, at this session's own first write, makes this session's file the sole source from then on
 * ([/decisions/ad-122.md](/decisions/ad-122.md)).
 */
function inheritedBase(
  root: string,
  provider: string,
  sessionKey: string,
  isLive: LivenessCheck,
): HandoffProviderSlice {
  const predecessor = findDeadPredecessor(root, provider, sessionKey, { isLive });
  if (!predecessor) {
    return EMPTY_SLICE;
  }
  const path = handoffSessionPath(root, predecessor.owner.session_key);
  return shouldInject(verifySeal(path)) ? predecessor.slice : EMPTY_SLICE;
}

/** why: the owner is restamped on every write because this session wrote just now, which is the fact worth
 * keeping — liveness itself is decided elsewhere, against presence's own heartbeat
 * ([/decisions/ad-122.md](/decisions/ad-122.md)). */
export function patchHandoffSession(
  root: string,
  provider: string,
  sessionKey: string,
  patch: Partial<HandoffProviderSlice>,
  options: PredecessorOptions = {},
): Promise<HandoffSessionFile> {
  const isLive = options.isLive ?? defaultLiveness(root);
  const path = handoffSessionPath(root, sessionKey);
  return updateJsonAtomic<HandoffSessionFile>(
    path,
    (current) => {
      const base =
        current && isHandoffSessionFile(current)
          ? current.slice
          : inheritedBase(root, provider, sessionKey, isLive);
      const now = new Date().toISOString();
      return {
        schema: HANDOFF_SESSION_SCHEMA,
        owner: { session_key: sessionKey, provider, updated_at: now },
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

function mostRecent(files: readonly HandoffSessionFile[]): HandoffSessionFile | null {
  if (files.length === 0) {
    return null;
  }
  return files.reduce((latest, file) => (file.owner.updated_at > latest.owner.updated_at ? file : latest));
}

type LivenessCheck = (provider: string, sessionKey: string) => boolean;

function defaultLiveness(root: string): LivenessCheck {
  return (provider, sessionKey) => isSessionLive(root, provider, sessionKey);
}

export type PredecessorOptions = {
  isLive?: LivenessCheck;
};

/**
 * why: the most-recently-updated *other* session of this provider whose conversation is confirmed not live is
 * a legitimate handoff. A live neighbour, however recent, is never a candidate — that is the one property this
 * whole file exists to guarantee ([/decisions/ad-122.md](/decisions/ad-122.md)).
 */
export function findDeadPredecessor(
  root: string,
  provider: string,
  sessionKey: string,
  options: PredecessorOptions = {},
): HandoffSessionFile | null {
  const isLive = options.isLive ?? defaultLiveness(root);
  const candidates = readAllSessionFiles(root)
    .map((entry) => entry.file)
    .filter((file) => file.owner.provider === provider && file.owner.session_key !== sessionKey)
    .filter((file) => !isLive(file.owner.provider, file.owner.session_key));
  return mostRecent(candidates);
}

/** The most-recently-updated session file for a *given* provider, regardless of liveness — used both for the
 * requesting provider's own foreign-slice lookups and for the operator's diagnostic view
 * ([/decisions/ad-039.md](/decisions/ad-039.md) precedent: informational, not continuity). */
export function latestSessionForProvider(root: string, provider: string): HandoffSessionFile | null {
  const candidates = readAllSessionFiles(root)
    .map((entry) => entry.file)
    .filter((file) => file.owner.provider === provider);
  return mostRecent(candidates);
}

export type PruneOptions = {
  now?: number;
  staleMs?: number;
  isLive?: LivenessCheck;
};

const HANDOFF_SESSION_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * why: a not-live session's file is exactly what the *next* session inherits from, so deleting it the moment
 * its conversation goes quiet would remove the handoff before anyone reads it — and never deleting it would
 * grow the directory forever. Seven days is long enough for a same-week restart to still inherit, and bounded
 * enough that it does not accumulate without limit. The seal sidecar is removed alongside the session file.
 */
export function pruneDeadHandoffSessions(root: string, options: PruneOptions = {}): number {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? HANDOFF_SESSION_STALE_MS;
  const isLive = options.isLive ?? defaultLiveness(root);
  let pruned = 0;
  for (const entry of readAllSessionFiles(root)) {
    const age = now - Date.parse(entry.file.owner.updated_at);
    if (Number.isNaN(age) || age < staleMs) {
      continue;
    }
    if (isLive(entry.file.owner.provider, entry.file.owner.session_key)) {
      continue;
    }
    try {
      unlinkSync(entry.path);
      pruned += 1;
    } catch {
      continue;
    }
    try {
      unlinkSync(sealPath(entry.path));
    } catch {}
  }
  return pruned;
}
