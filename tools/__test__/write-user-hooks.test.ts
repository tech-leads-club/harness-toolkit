import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { CursorHookDef, CursorHooksDocument } from "../../bin/write-user-hooks.d.mts";
import {
  applyCursorWiring,
  applyProviderWiring,
  isProviderHomePresent,
  renderCursorHooksDocument,
} from "../../bin/write-user-hooks.mjs";
import type { ProviderWiring, WiringEntry } from "../../src/contracts/index.ts";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "write-user-hooks-"));
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected item at index ${index}`);
  return item;
}

function hookGroup(document: CursorHooksDocument, hookEvent: string): CursorHookDef[] {
  const group = document.hooks[hookEvent];
  assert.ok(group !== undefined, `expected a hooks group for ${hookEvent}`);
  return group;
}

const cleanupRoots: string[] = [];

function newRoot(): string {
  const root = fixtureRoot();
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

function cursorEntries(launcherPath: string): WiringEntry[] {
  return [
    {
      hookEvent: "sessionStart",
      handler: "session-bootstrap",
      command: "node",
      args: [launcherPath, "session-bootstrap"],
      timeoutSeconds: 10,
    },
    {
      hookEvent: "stop",
      handler: "verify-gates",
      command: "node",
      args: [launcherPath, "verify-gates"],
      timeoutSeconds: 120,
      loopLimit: 5,
    },
    {
      hookEvent: "stop",
      handler: "obs-stop",
      command: "node",
      args: [launcherPath, "obs-stop"],
      timeoutSeconds: 10,
    },
    {
      hookEvent: "preToolUse",
      handler: "pre-tool-use",
      command: "node",
      args: [launcherPath, "pre-tool-use"],
      timeoutSeconds: 5,
      failClosed: true,
    },
    {
      hookEvent: "afterFileEdit",
      handler: "format",
      command: "node",
      args: [launcherPath, "format"],
      timeoutSeconds: 30,
      matcher: "Write",
    },
  ];
}

function cursorWiringFixture(root: string): ProviderWiring {
  const cursorHome = join(root, "cursor-home");
  mkdirSync(cursorHome, { recursive: true });
  return {
    target: join(cursorHome, "hooks.json"),
    kind: "cursor-hooks-json",
    strategy: "replace",
    entries: cursorEntries(join(root, "launcher", "tlc-exec.mjs")),
  };
}

function claudeEntries(launcherPath: string): WiringEntry[] {
  return [
    {
      hookEvent: "SessionStart",
      handler: "session-start",
      command: "node",
      args: [launcherPath, "session-start"],
      timeoutSeconds: 10,
    },
  ];
}

function claudeWiringFixture(root: string): ProviderWiring {
  const claudeHome = join(root, "claude-home");
  mkdirSync(claudeHome, { recursive: true });
  return {
    target: join(claudeHome, "settings.json"),
    kind: "claude-settings-json",
    strategy: "merge",
    entries: claudeEntries(join(root, "launcher", "tlc-exec.mjs")),
  };
}

describe("renderCursorHooksDocument", () => {
  test("groups multiple entries under the same hookEvent, preserving order", () => {
    const document = renderCursorHooksDocument(cursorEntries("/launcher/tlc-exec.mjs"));
    assert.deepEqual(document.version, 1);
    const stop = hookGroup(document, "stop");
    assert.equal(stop.length, 2);
    assert.match(nth(stop, 0).command, /verify-gates/);
    assert.match(nth(stop, 1).command, /obs-stop/);
  });

  test("includes failClosed, matcher, and loop_limit only when present on the entry", () => {
    const document = renderCursorHooksDocument(cursorEntries("/launcher/tlc-exec.mjs"));
    assert.equal(nth(hookGroup(document, "sessionStart"), 0).failClosed, undefined);
    assert.equal(nth(hookGroup(document, "preToolUse"), 0).failClosed, true);
    assert.equal(nth(hookGroup(document, "afterFileEdit"), 0).matcher, "Write");
    const stop = hookGroup(document, "stop");
    assert.equal(nth(stop, 0).loop_limit, 5);
    assert.equal(nth(stop, 1).loop_limit, undefined);
  });

  test("quotes tokens containing a space and leaves plain tokens bare", () => {
    const document = renderCursorHooksDocument([
      {
        hookEvent: "sessionStart",
        handler: "session-bootstrap",
        command: "node",
        args: ["/path with space/tlc-exec.mjs", "session-bootstrap"],
        timeoutSeconds: 10,
      },
    ]);
    assert.equal(
      nth(hookGroup(document, "sessionStart"), 0).command,
      'node "/path with space/tlc-exec.mjs" session-bootstrap',
    );
  });
});

describe("applyCursorWiring", () => {
  test("writes a fresh hooks.json when none exists", () => {
    const root = newRoot();
    const wiring = cursorWiringFixture(root);
    const result = applyCursorWiring(wiring);
    assert.deepEqual(result, { status: "written", target: wiring.target });
    assert.ok(existsSync(wiring.target));
    const parsed = JSON.parse(readFileSync(wiring.target, "utf8"));
    assert.equal(parsed.version, 1);
  });

  test("re-running with identical entries reports unchanged", () => {
    const root = newRoot();
    const wiring = cursorWiringFixture(root);
    applyCursorWiring(wiring);
    const before = readFileSync(wiring.target, "utf8");
    const result = applyCursorWiring(wiring);
    assert.deepEqual(result, { status: "unchanged", target: wiring.target });
    assert.equal(readFileSync(wiring.target, "utf8"), before);
  });

  test("refuses a foreign, non-harness hooks.json without --force", () => {
    const root = newRoot();
    const wiring = cursorWiringFixture(root);
    const foreign = `${JSON.stringify({ version: 1, hooks: { stop: [{ command: "echo hi" }] } }, null, 2)}\n`;
    writeFileSync(wiring.target, foreign);
    const result = applyCursorWiring(wiring);
    assert.equal(result.status, "refused");
    assert.match(result.reason, /--force/);
    assert.equal(readFileSync(wiring.target, "utf8"), foreign);
  });

  test("overwrites a foreign hooks.json when --force is given", () => {
    const root = newRoot();
    const wiring = cursorWiringFixture(root);
    const foreign = `${JSON.stringify({ version: 1, hooks: { stop: [{ command: "echo hi" }] } }, null, 2)}\n`;
    writeFileSync(wiring.target, foreign);
    const result = applyCursorWiring(wiring, { force: true });
    assert.equal(result.status, "written");
    const parsed = JSON.parse(readFileSync(wiring.target, "utf8"));
    assert.ok(parsed.hooks.sessionStart);
  });
});

describe("applyProviderWiring", () => {
  test("dispatches replace-strategy wiring to the Cursor applier", () => {
    const root = newRoot();
    const wiring = cursorWiringFixture(root);
    const result = applyProviderWiring(wiring);
    assert.equal(result.status, "written");
    assert.ok(existsSync(wiring.target));
  });

  test("dispatches merge-strategy wiring to applyClaudeWiring, preserving unrelated keys", () => {
    const root = newRoot();
    const wiring = claudeWiringFixture(root);
    writeFileSync(wiring.target, `${JSON.stringify({ someOtherKey: "keep-me" }, null, 2)}\n`);
    const result = applyProviderWiring(wiring);
    assert.equal(result.status, "merged");
    const parsed = JSON.parse(readFileSync(wiring.target, "utf8"));
    assert.equal(parsed.someOtherKey, "keep-me");
    assert.ok(parsed.hooks.SessionStart);
  });

  test("reports unchanged when the Claude merge introduces no new hooks", () => {
    const root = newRoot();
    const wiring = claudeWiringFixture(root);
    applyProviderWiring(wiring);
    const result = applyProviderWiring(wiring);
    assert.equal(result.status, "unchanged");
  });

  // why: the discriminating case. `strategy` is deliberately the wrong one here — if dispatch still read
  // `strategy`, this would be written as a flat Cursor hooks document. Routing on `kind` is what sends it to the
  // merger, and a foreign key surviving is the proof it went there.
  test("routes on kind, not strategy, when the two disagree", () => {
    const root = newRoot();
    const wiring: ProviderWiring = { ...claudeWiringFixture(root), strategy: "replace" };
    writeFileSync(wiring.target, `${JSON.stringify({ someOtherKey: "keep-me" }, null, 2)}\n`);
    const result = applyProviderWiring(wiring);
    assert.equal(result.status, "merged");
    const parsed = JSON.parse(readFileSync(wiring.target, "utf8"));
    assert.equal(parsed.someOtherKey, "keep-me");
    assert.ok(parsed.hooks.SessionStart);
    assert.equal("version" in parsed, false, "a Cursor hooks document would have stamped version: 1");
  });

  // hazard: this file is .mjs and tsconfig does not cover it, so an unhandled kind cannot be a compile error here.
  // It has to fail loudly at runtime instead of falling through to whichever writer happens to be last.
  test("refuses a wiring kind it has no writer for, and writes nothing", () => {
    const root = newRoot();
    const wiring = { ...cursorWiringFixture(root), kind: "opencode-plugin" } as unknown as ProviderWiring;
    const result = applyProviderWiring(wiring);
    assert.equal(result.status, "failed");
    assert.ok("reason" in result && result.reason.includes("opencode-plugin"));
    assert.equal(existsSync(wiring.target), false, "a refused kind must not write the target");
  });

  test("reports a failure for malformed Claude settings.json without throwing", () => {
    const root = newRoot();
    const wiring = claudeWiringFixture(root);
    writeFileSync(wiring.target, "{ not valid json");
    const before = readFileSync(wiring.target, "utf8");
    const result = applyProviderWiring(wiring);
    assert.equal(result.status, "failed");
    assert.ok("reason" in result && result.reason.length > 0);
    assert.equal(readFileSync(wiring.target, "utf8"), before);
  });
});

describe("isProviderHomePresent", () => {
  test("is true when the target's parent directory exists", () => {
    const root = newRoot();
    const wiring = cursorWiringFixture(root);
    assert.equal(isProviderHomePresent(wiring), true);
  });

  test("is false when the target's parent directory does not exist", () => {
    const root = newRoot();
    const wiring: ProviderWiring = {
      target: join(root, "nonexistent-home", "hooks.json"),
      kind: "cursor-hooks-json",
      strategy: "replace",
      entries: [],
    };
    assert.equal(isProviderHomePresent(wiring), false);
  });
});

describe("provider dispatch loop (skip-when-absent, independent-failure semantics)", () => {
  test("skips a not-installed provider while still applying an installed one", () => {
    const root = newRoot();
    const installed = cursorWiringFixture(root);
    const notInstalled: ProviderWiring = {
      target: join(root, "absent-home", "hooks.json"),
      kind: "cursor-hooks-json",
      strategy: "replace",
      entries: [],
    };

    const outcomes = [installed, notInstalled].map((wiring) =>
      isProviderHomePresent(wiring)
        ? applyProviderWiring(wiring)
        : { status: "skipped", target: wiring.target },
    );

    assert.equal(nth(outcomes, 0).status, "written");
    assert.equal(nth(outcomes, 1).status, "skipped");
    assert.ok(existsSync(installed.target));
    assert.ok(!existsSync(dirname(notInstalled.target)));
  });

  test("a malformed Claude settings.json fails only that step; the Cursor step still succeeds", () => {
    const root = newRoot();
    const cursor = cursorWiringFixture(root);
    const claude = claudeWiringFixture(root);
    writeFileSync(claude.target, "{ not valid json");

    const results = [cursor, claude].map((wiring) => applyProviderWiring(wiring));
    const anyFailed = results.some((result) => result.status === "failed" || result.status === "refused");

    assert.equal(nth(results, 0).status, "written");
    assert.equal(nth(results, 1).status, "failed");
    assert.equal(anyFailed, true);
    assert.ok(existsSync(cursor.target));
  });
});
