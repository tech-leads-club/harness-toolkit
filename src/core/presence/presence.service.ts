import type { Decision } from "../../contracts/decision.ts";
import {
  deletePresenceRecord,
  listPresenceRecords,
  presenceSessionKey,
  readPresenceRecord,
  writePresenceRecord,
} from "./presence.store.ts";
import type { PresenceRecord } from "./presence.types.ts";

const STALE_MS = 10 * 60 * 1000;
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

export function heartbeat(
  root: string,
  args: { provider: string; session: string; file?: string; now?: Date },
): PresenceRecord | null {
  const existing = readPresenceRecord(root, args.provider, args.session);
  if (!existing) {
    return null;
  }
  const recent_files = args.file
    ? [...existing.recent_files.filter((f) => f !== args.file), args.file].slice(-RECENT_FILES_MAX)
    : existing.recent_files;
  const next: PresenceRecord = {
    ...existing,
    heartbeat_at: (args.now ?? new Date()).toISOString(),
    recent_files,
  };
  writePresenceRecord(root, next);
  return next;
}

function heartbeatAgeMs(record: PresenceRecord, now: number): number {
  const at = Date.parse(record.heartbeat_at);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now - at;
}

function isStale(record: PresenceRecord, now: number): boolean {
  return heartbeatAgeMs(record, now) >= STALE_MS;
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
    if (isStale(record, nowMs)) {
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
    if (isStale(record, now.getTime())) {
      deletePresenceRecord(root, record.provider, record.session);
      swept += 1;
    }
  }
  return swept;
}

export function release(root: string, provider: string, session: string): void {
  deletePresenceRecord(root, provider, session);
}

export { listPresenceRecords, presenceSessionKey, readPresenceRecord };
