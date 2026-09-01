import type { Decision } from "../../contracts/decision.ts";
import {
  deletePresenceRecord,
  listPresenceRecords,
  presenceSessionKey,
  readPresenceRecord,
  writePresenceRecord,
} from "./presence.store.ts";
import type { PresenceRecord } from "./presence.types.ts";

/** how long a file-edit claim (`checkCollision`'s `recent_files`) survives without a fresh touch — unrelated
 * to whether the session's own conversation is still open, see `CONVERSATION_STALE_MS`. */
const CLAIM_STALE_MS = 10 * 60 * 1000;

/** why longer than the claim window: a conversation can sit quiet — reading long output, thinking — for well
 * past ten minutes without being over, and both `isSessionLive` and `sweepStale` must agree on that same
 * question so a record is never physically deleted while a reader would still call it live
 * ([/decisions/ad-122.md](/decisions/ad-122.md)), matching this codebase's own precedent for the same class of
 * stale-but-alive tolerance (`GATE_LOCK_STALE_MS`, `src/core/gate/gate.lock.ts`). */
const CONVERSATION_STALE_MS = 30 * 60 * 1000;

const RECENT_FILES_MAX = 20;

export function register(
  root: string,
  args: { provider: string; session: string; pid: number; branch: string; now?: Date },
): PresenceRecord {
  const now = (args.now ?? new Date()).toISOString();
  const record: PresenceRecord = {
    provider: args.provider,
    session: args.session,
    pid: args.pid,
    branch: args.branch,
    started_at: now,
    heartbeat_at: now,
    recent_files: [],
  };
  writePresenceRecord(root, record);
  return record;
}

/**
 * why self-healing: `sweepStale` deletes a record once it looks quiet, but quiet is not the same fact as over —
 * a session whose next event arrives after that deletion is not a new session, and treating its own heartbeat
 * as a no-op would leave it misdiagnosed as a dead predecessor by every other reader, permanently, since nothing
 * else ever re-creates the file. This event is itself proof the conversation is still going, so it is always
 * enough to (re)establish presence, register() or not ([/decisions/ad-122.md](/decisions/ad-122.md)).
 */
export function heartbeat(
  root: string,
  args: { provider: string; session: string; file?: string; now?: Date },
): PresenceRecord {
  const existing = readPresenceRecord(root, args.provider, args.session);
  const now = (args.now ?? new Date()).toISOString();
  const recent_files = args.file
    ? [...(existing?.recent_files.filter((f) => f !== args.file) ?? []), args.file].slice(-RECENT_FILES_MAX)
    : (existing?.recent_files ?? []);
  const next: PresenceRecord = {
    provider: args.provider,
    session: args.session,
    pid: process.pid,
    branch: existing?.branch ?? "unknown",
    started_at: existing?.started_at ?? now,
    heartbeat_at: now,
    recent_files,
  };
  writePresenceRecord(root, next);
  return next;
}

function heartbeatAgeMs(record: PresenceRecord, now: number): number {
  const at = Date.parse(record.heartbeat_at);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now - at;
}

function isStale(record: PresenceRecord, now: number, staleMs: number): boolean {
  return heartbeatAgeMs(record, now) >= staleMs;
}

function elapsedLabel(record: PresenceRecord, now: number): string {
  const minutes = Math.max(0, Math.round(heartbeatAgeMs(record, now) / 60_000));
  return minutes <= 1 ? "just now" : `${minutes} minutes ago`;
}

export function checkCollision(
  root: string,
  file: string,
  ownSessionKey: string,
  now: Date = new Date(),
): Decision {
  const nowMs = now.getTime();
  for (const record of listPresenceRecords(root)) {
    if (presenceSessionKey(record.provider, record.session) === ownSessionKey) {
      continue;
    }
    if (isStale(record, nowMs, CLAIM_STALE_MS)) {
      continue;
    }
    if (!record.recent_files.includes(file)) {
      continue;
    }
    const elapsed = elapsedLabel(record, nowMs);
    /**
     * hazard: this said "touched" and "edited this file" for a claim that a *read* could create, so the message
     * asserted an edit that had not happened — and an operator checking `git status` found one modification, their
     * own. Only a write claims now, and the words say so ([/decisions/ad-099.md](/decisions/ad-099.md)).
     *
     * invariant: the way out is named. `ask` becomes a refusal wherever no operator can answer the prompt, and a
     * refusal with no exit is a lock-out.
     */
    return {
      kind: "ask",
      reason: `${record.provider} session ${record.session} wrote ${file} ${elapsed}.`,
      userNote: `Another agent (${record.provider}, session ${record.session}) wrote this file ${elapsed}. Coordinate before proceeding: end that session, or wait for its claim to go stale (10 minutes without a heartbeat). \`tlc harness status\` lists the live sessions.`,
      // why: this asks unconditionally, like the floor does, and carried no rule — so an operator reading a rate of
      // interruptions could see the count and not the cause.
      rule: "edit-collision",
    };
  }
  return { kind: "allow" };
}

export function sweepStale(root: string, now: Date = new Date()): number {
  let swept = 0;
  for (const record of listPresenceRecords(root)) {
    if (isStale(record, now.getTime(), CONVERSATION_STALE_MS)) {
      deletePresenceRecord(root, record.provider, record.session);
      swept += 1;
    }
  }
  return swept;
}

export function release(root: string, provider: string, session: string): void {
  deletePresenceRecord(root, provider, session);
}

/**
 * why the session key, not the raw session id: every caller outside this module already carries the prefixed
 * form (`${provider}-${id}`) — every inbound mapper produces it that way — and asking each one to also derive
 * the bare id is the duplication a shared helper exists to remove.
 */
function sessionIdFromSessionKey(provider: string, sessionKey: string): string {
  const prefix = `${provider}-`;
  return sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : sessionKey;
}

/**
 * why heartbeat and not a process check: this harness's hook processes are one-shot — every entrypoint calls
 * `process.exit` at the end of the single event it handled ([/decisions/ad-122.md](/decisions/ad-122.md)) — so
 * no pid outlives the event that recorded it, and a pid-liveness check answers "dead" for every session,
 * including one still very much in conversation. A heartbeat refreshed on every recognized event, regardless of
 * which process handled it, is the one signal that survives the process boundary.
 */
export function isSessionLive(
  root: string,
  provider: string,
  sessionKey: string,
  now: Date = new Date(),
): boolean {
  const record = readPresenceRecord(root, provider, sessionIdFromSessionKey(provider, sessionKey));
  return record !== null && !isStale(record, now.getTime(), CONVERSATION_STALE_MS);
}

export { listPresenceRecords, presenceSessionKey, readPresenceRecord };
