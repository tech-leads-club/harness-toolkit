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
