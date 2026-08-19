import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * A hash the harness records after every write it makes to a file it later reads aloud to the model.
 *
 * why: the policy baseline answers "did this change since the session started", which is the right question for a
 * file only an operator edits. The handoff changes every turn by design, so the question here is different — did
 * something *other than the harness* change it. One write path per file makes that answerable
 * ([/decisions/ad-078.md](/decisions/ad-078.md)).
 *
 * invariant: this is defence in depth and not the first line. The floor already refuses an agent write to either
 * file, because both sit under the project state directory. What this catches is a write the floor did not see —
 * another process, an MCP server with filesystem access, a route through a tool nothing named.
 */
export type SealVerdict = "sealed" | "unsealed" | "diverged" | "absent";

const SCHEMA = "harness.seal.v1";

export function sealPath(target: string): string {
  return join(dirname(target), ".seal", `${basename(target)}.json`);
}

function hashOf(target: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(target)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * why: called inside the write lock. A seal recorded after the lock releases races the next writer, and the pair
 * that loses leaves a seal matching neither content.
 */
export function seal(target: string): void {
  const hash = hashOf(target);
  if (hash === null) {
    return;
  }
  try {
    mkdirSync(dirname(sealPath(target)), { recursive: true });
    writeFileSync(sealPath(target), JSON.stringify({ schema: SCHEMA, hash }));
  } catch {
    // invariant: a seal that cannot be written is not an error the turn should carry. The next verify reads
    // `unsealed` and adopts, which is the same state as a fresh install.
  }
}

export function verifySeal(target: string): SealVerdict {
  if (!existsSync(target)) {
    return "absent";
  }
  let recorded: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(sealPath(target), "utf8")) as { hash?: unknown };
    recorded = typeof parsed.hash === "string" ? parsed.hash : null;
  } catch {
    recorded = null;
  }
  if (recorded === null) {
    // why: adopted, not refused. Every install that predates sealing has no sidecar, and refusing on absence
    // would break all of them. The cost is stated: deleting the sidecar buys one unverified read.
    return "unsealed";
  }
  return hashOf(target) === recorded ? "sealed" : "diverged";
}

/** why: one place decides what withholding means, so the two call sites cannot disagree about it. */
export function shouldInject(verdict: SealVerdict): boolean {
  return verdict !== "diverged";
}

export function divergedMessage(target: string, what: string): string {
  return [
    `${what} at ${target} changed without a harness write behind it, so it was not injected into this turn.`,
    "That file is read aloud to the model, so text placed in it reaches every later turn. Read it, and if the",
    "contents are yours, the next harness write reseals it.",
  ].join("\n");
}
