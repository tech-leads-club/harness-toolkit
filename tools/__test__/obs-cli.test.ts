import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { ObsEvent } from "../../src/core/observability/observability.types.ts";
import { projectStateDir } from "../../src/platform/paths.ts";
import { latestSessionId, limitFrom, liveEvents, liveJson, liveText, NO_EVENTS } from "../obs-cli.ts";

const cleanupRoots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-obs-cli-"));
  cleanupRoots.push(root);
  return root;
}

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function event(kind: ObsEvent["kind"], ts: string): ObsEvent {
  return {
    schema: "harness.observability.v1",
    provider: "claude",
    kind,
    level: "signal",
    ts,
    trace_id: "trace-1",
    span_id: "span-1",
    attrs: { note: "x" },
  };
}

function writeObsLines(root: string, events: readonly ObsEvent[]): void {
  const dir = projectStateDir(root);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(dir, "obs.jsonl"), lines ? `${lines}\n` : "");
}

/**
 * AD-136 F1 — the exact incident shape: a real denial, followed by enough non-allowlisted noise
 * (`hook.enter`) to fill a naive tail truncated before filtering.
 */
describe("liveEvents", () => {
  test("a policy.deny stays visible behind a flood of non-allowlisted noise", () => {
    const root = newRoot();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const events: ObsEvent[] = [event("policy.deny", new Date(base).toISOString())];
    for (let i = 0; i < 60; i += 1) {
      events.push(event("hook.enter" as ObsEvent["kind"], new Date(base + (i + 1) * 1000).toISOString()));
    }
    writeObsLines(root, events);

    const live = liveEvents(root, 40);

    assert.ok(
      live.some((e) => e.kind === "policy.deny"),
      "the denial must survive the flood",
    );
  });

  test("the tail is still cut to the requested limit once filtered", () => {
    const root = newRoot();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const events: ObsEvent[] = [];
    for (let i = 0; i < 100; i += 1) {
      events.push(event("session.start", new Date(base + i * 1000).toISOString()));
    }
    writeObsLines(root, events);

    const live = liveEvents(root, 10);

    assert.equal(live.length, 10);
    assert.equal(live[live.length - 1]?.ts, new Date(base + 99 * 1000).toISOString());
  });

  test("a kind not on the allowlist is excluded even when nothing else competes for the window", () => {
    const root = newRoot();
    writeObsLines(root, [event("hook.enter" as ObsEvent["kind"], "2026-01-01T00:00:00.000Z")]);

    const live = liveEvents(root, 40);

    assert.equal(live.length, 0);
  });
});

describe("liveText", () => {
  test("names the empty case instead of printing a blank line", () => {
    assert.equal(liveText([]), NO_EVENTS);
  });

  test("renders one tab-separated line per event", () => {
    const text = liveText([event("gate.outcome", "2026-07-30T10:00:00.000Z")]);
    assert.equal(text.split("\n").length, 1);
    assert.ok(text.startsWith("2026-07-30T10:00:00.000Z\tgate.outcome\t"));
  });
});

describe("liveJson", () => {
  test("carries a count alongside the events, and survives a JSON round trip", () => {
    const events = [
      event("gate.outcome", "2026-07-30T10:00:00.000Z"),
      event("gate.outcome", "2026-07-30T10:01:00.000Z"),
    ];
    const projected = liveJson(events);
    assert.equal(projected.count, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);
  });

  test("an empty read is a count of zero, not an error", () => {
    assert.deepEqual(liveJson([]), { count: 0, events: [] });
  });
});

describe("limitFrom", () => {
  test("uses the fallback when the argument is absent or not a number", () => {
    assert.equal(limitFrom(undefined, 40), 40);
    assert.equal(limitFrom("many", 50), 50);
  });

  test("honours a numeric argument", () => {
    assert.equal(limitFrom("7", 40), 7);
  });
});

describe("latestSessionId", () => {
  test("returns null when no sessions directory exists", () => {
    assert.equal(latestSessionId(newRoot()), null);
  });

  test("returns null when the directory holds no rollups", () => {
    const root = newRoot();
    mkdirSync(join(projectStateDir(root), "sessions"), { recursive: true });
    assert.equal(latestSessionId(root), null);
  });

  /**
   * hazard: this asserted "the last id in sort order", with fixtures named `aaa` and `zzz` written in that order —
   * so alphabetical order and time order agreed and the assertion could not tell them apart. Session ids are
   * UUIDs, where they do not agree: on a real machine it selected a session from thirteen days earlier whose every
   * counter was zero, which reads exactly like "the harness did nothing". The command that answers "what did the
   * harness do" was answering about the wrong session.
   */
  test("picks the newest session by time, even when it sorts first by name", () => {
    const root = newRoot();
    const sessions = join(projectStateDir(root), "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "zzz-older.json"), "{}");
    utimesSync(join(sessions, "zzz-older.json"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    writeFileSync(join(sessions, "aaa-newer.json"), "{}");
    utimesSync(join(sessions, "aaa-newer.json"), new Date(2026, 0, 1), new Date(2026, 0, 1));
    writeFileSync(join(sessions, "ignored.txt"), "x");
    assert.equal(latestSessionId(root), "aaa-newer");
  });

  test("a tie on time breaks on the name, so the answer is deterministic", () => {
    const root = newRoot();
    const sessions = join(projectStateDir(root), "sessions");
    mkdirSync(sessions, { recursive: true });
    const when = new Date(2026, 0, 1);
    for (const name of ["b.json", "a.json", "c.json"]) {
      writeFileSync(join(sessions, name), "{}");
      utimesSync(join(sessions, name), when, when);
    }
    assert.equal(latestSessionId(root), "c");
  });
});
