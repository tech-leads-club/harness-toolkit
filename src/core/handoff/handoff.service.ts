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
import type { ForeignSlice, HandoffProviderSlice, HandoffShared } from "./handoff.types.ts";

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
 * This session's own resolved continuity: shared project facts, a dead predecessor's carried fields where
 * this session has not yet written its own, and this session's own fields wherever it has
 * ([/decisions/ad-122.md](/decisions/ad-122.md)). A *live* other session is never a source — see
 * `findDeadPredecessor`.
 */
export function readHandoff(root: string, provider: string, sessionKey: string): ResolvedHandoff {
  const shared = readHandoffFile(root).shared;
  const predecessor = findDeadPredecessor(root, provider, sessionKey);
  const own = readHandoffSessionFile(root, sessionKey);
  return { ...shared, ...predecessor?.slice, ...own?.slice };
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
  const otherProviders = new Set(
    listHandoffSessionFiles(root)
      .map((file) => file.owner.provider)
      .filter((name) => name !== provider),
  );
  const foreign: ForeignSlice[] = [];
  for (const name of otherProviders) {
    const latest = latestSessionForProvider(root, name);
    if (!latest) {
      continue;
    }
    if (latest.slice.next_action === undefined && latest.slice.blockers === undefined) {
      continue;
    }
    foreign.push({ provider: name, next_action: latest.slice.next_action, blockers: latest.slice.blockers });
  }
  return foreign;
}

export { handoffSessionPath, listHandoffSessionFiles, pruneDeadHandoffSessions, readHandoffFile };
