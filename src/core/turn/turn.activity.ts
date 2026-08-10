import { readSignalEvents } from "../observability/observability.store.ts";
import type { ObsEvent } from "../observability/observability.types.ts";

/**
 * hazard: this set was right and the file it was read from was not. A tool call that succeeds resolves to the
 * **debug** plane, so `obs.jsonl` — the signal plane — holds none of them. Measured on this repository's own
 * state: `obs.jsonl` carried 0 `tool.end` and 0 `shell.end`, while `debug.jsonl` carried 322, 1909, and 981
 * `file.edit`. So the counter read zero for every turn whose work went well, and the rail's central claim — that
 * it counts what the harness recorded and therefore cannot be talked around — was inverted: nothing could
 * satisfy it ([/decisions/ad-059.md](/decisions/ad-059.md)).
 */
const TOOL_KINDS = new Set([
  "tool.start",
  "tool.end",
  "tool.fail",
  "shell.start",
  "shell.end",
  "mcp.start",
  "mcp.end",
  "file.edit",
  "file.read",
]);
const TURN_START = "prompt.submit";

// why: the signal plane holds the turn boundary and the debug plane holds the work. Neither alone answers
// "did this turn do anything".
export const ACTIVITY_PLANES = ["obs.jsonl", "debug.jsonl"] as const;

export type TurnActivity = {
  toolCalls: number;
  sawTurnStart: boolean;
};

function forSession(event: ObsEvent, sessionKey: string): boolean {
  return event.session_id === sessionKey;
}

/**
 * invariant: the window boundary is a timestamp, not a position. `prompt.submit` only ever lands on the signal
 * plane while the events counted inside the window come from both, and two files cannot share an index.
 */
export function activitySince(events: readonly ObsEvent[], sessionKey: string): TurnActivity {
  const mine = events.filter((event) => forSession(event, sessionKey));
  let startTs: string | null = null;
  for (const event of mine) {
    if (event.kind === TURN_START && (startTs === null || event.ts > startTs)) {
      startTs = event.ts;
    }
  }
  const boundary = startTs;
  // hazard: `>` dropped any event sharing the boundary's millisecond, and `toISOString` has exactly that
  // resolution — two records written back to back land on the same stamp. It surfaced as a test that passed
  // twice and failed on the third run of the same suite, which is the shape of a race rather than a bug in the
  // rule. `>=` includes the boundary instant; `prompt.submit` is not a counted kind, so including it costs
  // nothing.
  const window = boundary === null ? mine : mine.filter((event) => event.ts >= boundary);
  return {
    toolCalls: window.filter((event) => TOOL_KINDS.has(event.kind)).length,
    sawTurnStart: boundary !== null,
  };
}

export function readTurnActivity(root: string, sessionKey: string, limit = 500): TurnActivity {
  return activitySince(
    ACTIVITY_PLANES.flatMap((plane) => readSignalEvents(root, plane, limit)),
    sessionKey,
  );
}

export type IdleTurnInput = {
  activity: TurnActivity;
  changedFiles: number;
  hasOpenWork: boolean;
};

export function endedWithoutActing(input: IdleTurnInput): boolean {
  if (!input.hasOpenWork) {
    return false;
  }
  if (!input.activity.sawTurnStart) {
    return false;
  }
  return input.activity.toolCalls === 0 && input.changedFiles === 0;
}

export function idleTurnMessage(): string {
  return [
    "BLOCKED: this turn ended with open work, no tool call, and no file change.",
    "TRIED: counted tool events since the last prompt in this session — nothing ran.",
    "NEED: attempt the work. If a decision is genuinely blocking, state the assumption you are",
    "proceeding under in one line and continue; escalate only for an irreversible action, a real",
    "dead-end after searching, or ambiguity that would make the result useless if guessed wrong.",
  ].join("\n");
}
