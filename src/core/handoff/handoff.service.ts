import { divergedMessage, shouldInject, verifySeal } from "../integrity/state-seal.ts";
import { handoffPath, patchHandoff, readHandoffFile } from "./handoff.store.ts";
import type { ForeignSlice, HandoffProviderSlice, HandoffShared } from "./handoff.types.ts";

export type ResolvedHandoff = HandoffShared & HandoffProviderSlice;

/**
 * Whether the handoff is safe to read aloud to the model.
 *
 * why: separate from `readHandoff`, because reading and injecting are different acts. `tlc harness handoff`
 * displaying a diverged file is how an operator investigates it; a turn being *told* what it says is the moment
 * worth withholding ([/decisions/ad-078.md](/decisions/ad-078.md)).
 */
export function handoffInjectable(root: string): { ok: boolean; note: string | null } {
  const target = handoffPath(root);
  const verdict = verifySeal(target);
  return shouldInject(verdict)
    ? { ok: true, note: null }
    : { ok: false, note: divergedMessage(target, "The handoff") };
}

export function readHandoff(root: string, provider: string): ResolvedHandoff {
  const file = readHandoffFile(root);
  const slice = file.by_provider[provider] ?? { updated_at: file.shared.updated_at };
  return { ...file.shared, ...slice };
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
 * why: an operator's escape hatch. These are the exact fields `subagent-stop.ts` reads as "unfinished
 * work" — clearing anything wider would erase state no gate is stuck on.
 */
export async function clearStuckSignals(root: string): Promise<string[]> {
  const file = readHandoffFile(root);
  const cleared: string[] = [];
  for (const [provider, slice] of Object.entries(file.by_provider)) {
    if (!hasStuckSignal(slice)) {
      continue;
    }
    await patchHandoff(root, provider, { slice: CLEARED_SLICE });
    cleared.push(provider);
  }
  return cleared;
}

export function readForeignSlices(root: string, provider: string): ForeignSlice[] {
  const file = readHandoffFile(root);
  const foreign: ForeignSlice[] = [];
  for (const [name, slice] of Object.entries(file.by_provider)) {
    if (name === provider) {
      continue;
    }
    if (slice.next_action === undefined && slice.blockers === undefined) {
      continue;
    }
    foreign.push({ provider: name, next_action: slice.next_action, blockers: slice.blockers });
  }
  return foreign;
}

export { patchHandoff, readHandoffFile };
