import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderCapabilities } from "../../../contracts/capabilities.ts";
import type { HarnessEvent } from "../../../contracts/harness-event.ts";
import { bootDir } from "../../../platform/paths.ts";
import {
  checkLoopCap,
  currentLoopCount,
  effectiveLoopCount,
  markBooted,
  nextLoop,
  resetLoop,
} from "../turn.loop-counter.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-turn-"));
}

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    enforcesHooks: true,
    askSupportedOn: [],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: false,
    toolOutputRewrite: false,
    contextAtToolBefore: false,
    contextAtToolAfter: false,
    contextAtStop: false,
    sessionStartContextReliable: false,
    toolOutputAtAfter: false,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
    ...overrides,
  };
}

function event(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    provider: "provider-a",
    event: "stop",
    sessionKey: "session-a",
    projectDir: "/tmp/does-not-matter",
    raw: {},
    ...overrides,
  };
}

test("nextLoop increments monotonically and persists across calls", () => {
  const root = tempRoot();
  try {
    assert.equal(nextLoop(root, "session-a"), 1);
    assert.equal(nextLoop(root, "session-a"), 2);
    assert.equal(nextLoop(root, "session-a"), 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("currentLoopCount is 0 for a session never incremented", () => {
  const root = tempRoot();
  try {
    assert.equal(currentLoopCount(root, "unseen"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resetLoop zeroes the counter", () => {
  const root = tempRoot();
  try {
    nextLoop(root, "session-a");
    nextLoop(root, "session-a");
    resetLoop(root, "session-a");
    assert.equal(currentLoopCount(root, "session-a"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resetLoop on an unseen session does not throw", () => {
  const root = tempRoot();
  try {
    assert.doesNotThrow(() => resetLoop(root, "never-incremented"));
    assert.equal(currentLoopCount(root, "never-incremented"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nextLoop keeps separate sessions independent", () => {
  const root = tempRoot();
  try {
    nextLoop(root, "session-a");
    nextLoop(root, "session-a");
    nextLoop(root, "session-b");
    assert.equal(currentLoopCount(root, "session-a"), 2);
    assert.equal(currentLoopCount(root, "session-b"), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("currentLoopCount reflects the value nextLoop just returned", () => {
  const root = tempRoot();
  try {
    const returned = nextLoop(root, "session-a");
    assert.equal(currentLoopCount(root, "session-a"), returned);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("six consecutive increments against maxLoops 5 report the cap reached exactly at the sixth", () => {
  const root = tempRoot();
  try {
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const count = nextLoop(root, "session-a");
      results.push(checkLoopCap(count, 5).capReached);
    }
    assert.deepEqual(results, [false, false, false, false, false, true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkLoopCap at exactly maxLoops has not yet reached the cap", () => {
  assert.equal(checkLoopCap(5, 5).capReached, false);
});

test("effectiveLoopCount returns the payload value when the provider has a native counter", () => {
  const root = tempRoot();
  try {
    const result = effectiveLoopCount(
      event({ projectDir: root, loopCount: 7 }),
      capabilities({ nativeLoopCounter: true }),
    );
    assert.equal(result, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveLoopCount defaults to 0 when the native counter reports nothing", () => {
  const root = tempRoot();
  try {
    const result = effectiveLoopCount(event({ projectDir: root }), capabilities({ nativeLoopCounter: true }));
    assert.equal(result, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveLoopCount ignores the payload and uses the stored count when there is no native counter", () => {
  const root = tempRoot();
  try {
    nextLoop(root, "session-a");
    nextLoop(root, "session-a");
    const result = effectiveLoopCount(
      event({ projectDir: root, loopCount: 99 }),
      capabilities({ nativeLoopCounter: false }),
    );
    assert.equal(result, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("markBooted is idempotent — the second call reports already booted", () => {
  const root = tempRoot();
  try {
    assert.equal(markBooted(root, "session-a").alreadyBooted, false);
    assert.equal(markBooted(root, "session-a").alreadyBooted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the boot stamp filename is sanitized for an unsafe session key", () => {
  const root = tempRoot();
  try {
    markBooted(root, "provider-a:weird/id");
    const names = readdirSync(bootDir(root));
    assert.equal(names.length, 1);
    assert.equal(/[:\\/]/.test(names[0] ?? ""), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
