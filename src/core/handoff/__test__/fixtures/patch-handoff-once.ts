import { patchHandoffSession } from "../../handoff.session-store.ts";
import { patchHandoffShared } from "../../handoff.store.ts";
import type { HandoffProviderSlice, HandoffShared } from "../../handoff.types.ts";

const [, , root, provider, sessionKey, patchJson] = process.argv;
if (!root || !provider || !sessionKey || !patchJson) {
  console.error("usage: patch-handoff-once.ts <root> <provider> <sessionKey> <patchJson>");
  process.exit(1);
}

const patch = JSON.parse(patchJson) as {
  shared?: Partial<HandoffShared>;
  slice?: Partial<HandoffProviderSlice>;
};
if (patch.shared) {
  await patchHandoffShared(root, patch.shared);
}
if (patch.slice) {
  await patchHandoffSession(root, provider, sessionKey, patch.slice);
}
