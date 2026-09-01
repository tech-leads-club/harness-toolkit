import { patchHandoffSession } from "../../handoff.session-store.ts";
import type { HandoffProviderSlice } from "../../handoff.types.ts";

const [, , root, provider, sessionKey, patchJson] = process.argv;
if (!root || !provider || !sessionKey || !patchJson) {
  console.error("usage: patch-handoff-and-wait.ts <root> <provider> <sessionKey> <patchJson>");
  process.exit(1);
}

await patchHandoffSession(root, provider, sessionKey, JSON.parse(patchJson) as Partial<HandoffProviderSlice>);
console.log("ready");
await new Promise<never>(() => {});
