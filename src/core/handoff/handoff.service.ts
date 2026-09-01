import { divergedMessage, shouldInject, verifySeal } from "../integrity/state-seal.ts";
import {
  findDeadPredecessor,
  handoffSessionPath,
  latestSessionForProvider,
  listHandoffSessionFiles,
  patchHandoffSession,
  pruneDeadHandoffSessions,
  readHandoffSessionFile,
} from "./handoff.session-store.ts";
import { handoffPath, patchHandoffShared, readHandoffFile } from "./handoff.store.ts";
import type {
  ForeignSlice,
  HandoffProviderSlice,
  HandoffSessionFile,
  HandoffShared,
} from "./handoff.types.ts";

export type ResolvedHandoff = HandoffShared & HandoffProviderSlice;

/**
 * Whether the handoff is safe to read aloud to the model.
 *
 * why: the shared facts and this session's own continuity are two separately-sealed writes now
 * ([/decisions/ad-122.md](/decisions/ad-122.md)) — either one changing outside a harness write withholds the
 * whole handoff from this turn, the same as before the split.
 */
export function handoffInjectable(root: string, sessionKey: string): { ok: boolean; note: string | null } {
  const sharedVerdict = verifySeal(handoffPath(root));
  if (!shouldInject(sharedVerdict)) {
    return { ok: false, note: divergedMessage(handoffPath(root), "The handoff") };
  }
  const sessionPath = handoffSessionPath(root, sessionKey);
  const sessionVerdict = verifySeal(sessionPath);
  return shouldInject(sessionVerdict)
    ? { ok: true, note: null }
    : { ok: false, note: divergedMessage(sessionPath, "The handoff") };
}

/**
 * why: a file this turn merges in belongs to a *different* session, so nothing at the call site already
 * checked its seal the way `handoffInjectable` checks the caller's own — an untampered predecessor is the one
 * this function is allowed to promise ([/decisions/ad-078.md](/decisions/ad-078.md), read alongside AD-122).
 */
function sealedSlice(path: string, file: HandoffSessionFile | null): HandoffSessionFile | null {
  return file && shouldInject(verifySeal(path)) ? file : null;
}

/**
 * This session's own resolved continuity: shared facts plus this session's own slice
 * ([/decisions/ad-122.md](/decisions/ad-122.md)). A dead predecessor's fields are copied into this session's
 * own file once, at its first write (`patchHandoffSession`'s own materialization) — once that file exists, it
 * is the sole source, so a field this session later clears never resurfaces from the predecessor. Before this
 * session has written anything at all, the same not-live, seal-verified predecessor is read directly instead,
 * for a read that happens ahead of any write.
 */
export function readHandoff(root: string, provider: string, sessionKey: string): ResolvedHandoff {
  const shared = readHandoffFile(root).shared;
  const own = readHandoffSessionFile(root, sessionKey);
  if (own) {
    return { ...shared, ...own.slice };
  }
  const predecessor = findDeadPredecessor(root, provider, sessionKey);
  const verified =
    predecessor && sealedSlice(handoffSessionPath(root, predecessor.owner.session_key), predecessor);
  return { ...shared, ...verified?.slice };
}

/** The operator's diagnostic view of one provider: whichever session most recently wrote it, live or not —
 * reading here is not the injection surface AD-078 protects, so it is not liveness-gated. */
export function readLatestSlice(root: string, provider: string): ResolvedHandoff {
  const shared = readHandoffFile(root).shared;
  const latest = latestSessionForProvider(root, provider);
  return { ...shared, ...latest?.slice };
}

export type HandoffPatch = {
  shared?: Partial<HandoffShared>;
  slice?: Partial<HandoffProviderSlice>;
};

export async function patchHandoff(
  root: string,
  provider: string,
  sessionKey: string,
  patch: HandoffPatch,
): Promise<ResolvedHandoff> {
  if (patch.shared) {
    await patchHandoffShared(root, patch.shared);
  }
  if (patch.slice) {
    await patchHandoffSession(root, provider, sessionKey, patch.slice);
  }
  return readHandoff(root, provider, sessionKey);
}

const CLEARED_SLICE: Partial<HandoffProviderSlice> = {
  blockers: undefined,
  previous_gaps: undefined,
  last_failure_category: undefined,
  next_action: undefined,
};

function hasStuckSignal(slice: HandoffProviderSlice): boolean {
  return (Object.keys(CLEARED_SLICE) as (keyof HandoffProviderSlice)[]).some(
    (field) => slice[field] !== undefined,
  );
}

/**
 * why: the operator's escape hatch runs from their own terminal, never from inside an agent session
 * (`policy-surface-write` refuses it there) — by the time it runs, "which sessions are still live" is not the
 * question; a stuck signal left behind by any of them, dead or not, is what it clears.
 */
export async function clearStuckSignals(root: string): Promise<string[]> {
  const cleared: string[] = [];
  for (const file of listHandoffSessionFiles(root)) {
    if (!hasStuckSignal(file.slice)) {
      continue;
    }
    await patchHandoffSession(root, file.owner.provider, file.owner.session_key, CLEARED_SLICE);
    cleared.push(`${file.owner.provider}:${file.owner.session_key}`);
  }
  return cleared;
}

export function readForeignSlices(root: string, provider: string): ForeignSlice[] {
  const byProvider = new Map<string, HandoffSessionFile>();
  for (const file of listHandoffSessionFiles(root)) {
    if (file.owner.provider === provider) {
      continue;
    }
    const current = byProvider.get(file.owner.provider);
    if (!current || file.owner.updated_at > current.owner.updated_at) {
      byProvider.set(file.owner.provider, file);
    }
  }
  const foreign: ForeignSlice[] = [];
  for (const [name, latest] of byProvider) {
    const verified = sealedSlice(handoffSessionPath(root, latest.owner.session_key), latest);
    if (!verified) {
      continue;
    }
    if (verified.slice.next_action === undefined && verified.slice.blockers === undefined) {
      continue;
    }
    foreign.push({
      provider: name,
      next_action: verified.slice.next_action,
      blockers: verified.slice.blockers,
    });
  }
  return foreign;
}

export { handoffSessionPath, listHandoffSessionFiles, pruneDeadHandoffSessions, readHandoffFile };
