import assert from "node:assert/strict";
import { test } from "node:test";
import { HOOK_ENTRIES } from "../../../../bin/tlc-exec.mjs";
import type { RuntimePaths } from "../../../contracts/index.ts";
import {
  CODEX_SHORT_TIMEOUT_EVENTS,
  CODEX_SHORT_TIMEOUT_SECONDS,
  CODEX_TIMEOUT_CEILING_SECONDS,
  codexCommandString,
  codexWiring,
  mergeCodexHooks,
} from "../codex.wiring.ts";

const RUNTIME: RuntimePaths = { launcherPath: "/home/dev/.tlc/harness/bin/tlc-exec.mjs" };

const wiring = codexWiring(RUNTIME);

function hooksOf(text: string): Record<string, unknown[]> {
  return (JSON.parse(text) as { hooks: Record<string, unknown[]> }).hooks;
}

test("the wiring declares its own kind and merges rather than replaces", () => {
  assert.equal(wiring.kind, "codex-hooks-json");
  assert.equal(wiring.strategy, "merge");
  assert.ok(wiring.target.endsWith("hooks.json"), wiring.target);
});

// why: most Codex events carry no fingerprint at all, so the hint is what routes them to this adapter.
test("every entry launches with the codex provider hint and a handler the launcher accepts", () => {
  for (const entry of wiring.entries) {
    assert.deepEqual(entry.args.slice(0, 3), [RUNTIME.launcherPath, "--provider", "codex"]);
    assert.equal(entry.args.at(-1), entry.handler);
    assert.ok(HOOK_ENTRIES.has(entry.handler), entry.handler);
  }
});

/**
 * spec P3 AC6, first clause. Codex's documented shape nests `{ matcher, hooks: [{ type, command, timeout }] }`,
 * and the innermost `command` is a single string — not the `{ command, args }` exec form the nearest host uses,
 * which this file would otherwise have copied.
 */
test("each entry is emitted as a command string, never as an exec-form array", () => {
  const merged = mergeCodexHooks(null, wiring.entries);
  assert.ok(merged.ok);
  for (const [event, groups] of Object.entries(hooksOf(merged.hooksText))) {
    for (const group of groups as { hooks: Record<string, unknown>[] }[]) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, "command", event);
        assert.equal(typeof hook.command, "string", event);
        assert.equal(typeof hook.timeout, "number", event);
        assert.ok(!("args" in hook), `${event} emitted the exec form`);
      }
    }
  }
});

test("the command string is the launcher invocation, quoted only where a token holds a space", () => {
  const entry = wiring.entries[0];
  assert.ok(entry);
  assert.equal(codexCommandString(entry), `node ${RUNTIME.launcherPath} --provider codex ${entry.handler}`);
  const spaced = codexWiring({ launcherPath: "/Users/dev/My Tools/tlc-exec.mjs" }).entries[0];
  assert.ok(spaced);
  assert.ok(codexCommandString(spaced).includes('"/Users/dev/My Tools/tlc-exec.mjs"'));
});

/**
 * spec P3 AC6, third clause. `WiringEntry` carries both fields and the Codex schema has neither, so a value set
 * here would be a promise the host never reads.
 */
test("failClosed and loopLimit are absent from the entries and from the emitted document", () => {
  for (const entry of wiring.entries) {
    assert.equal(entry.failClosed, undefined, entry.hookEvent);
    assert.equal(entry.loopLimit, undefined, entry.hookEvent);
  }
  const merged = mergeCodexHooks(null, wiring.entries);
  assert.ok(merged.ok);
  assert.doesNotMatch(merged.hooksText, /failClosed|loop_?[Ll]imit/);
});

/**
 * spec P3 AC6, fourth clause, as amended in T2: `SessionEnd` and `Interrupt` are real events, they default to one
 * second and are capped at three, and 600 is the ceiling everywhere else.
 */
test("every timeout obeys the vendor's rule — 3 seconds on the capped events, 600 elsewhere", () => {
  for (const entry of wiring.entries) {
    const ceiling = CODEX_SHORT_TIMEOUT_EVENTS.includes(entry.hookEvent)
      ? CODEX_SHORT_TIMEOUT_SECONDS
      : CODEX_TIMEOUT_CEILING_SECONDS;
    assert.ok(
      entry.timeoutSeconds > 0 && entry.timeoutSeconds <= ceiling,
      `${entry.hookEvent} asks for ${entry.timeoutSeconds}s against a ceiling of ${ceiling}s`,
    );
  }
});

// why this is asserted rather than left implied: the criterion was amended precisely because an earlier draft
// forbade the event outright, on a claim AD-123 has since withdrawn.
test("SessionEnd is registered, and at the capped timeout", () => {
  const sessionEnd = wiring.entries.find((entry) => entry.hookEvent === "SessionEnd");
  assert.ok(sessionEnd, "SessionEnd is a real Codex event and is wired");
  assert.equal(sessionEnd.timeoutSeconds, CODEX_SHORT_TIMEOUT_SECONDS);
});

/**
 * why no entry for these two: `codex.inbound.ts` maps neither to a `HarnessEventKind`, so a hook here would launch
 * a process on every one and drop the payload.
 */
test("no entry is registered for an event the parser cannot map", () => {
  const events = wiring.entries.map((entry) => entry.hookEvent);
  assert.ok(!events.includes("PostCompact"));
  assert.ok(!events.includes("Interrupt"));
});

test("PermissionRequest gets its own entry, because it is a separate hook with its own vocabulary", () => {
  const entry = wiring.entries.find((e) => e.hookEvent === "PermissionRequest");
  assert.ok(entry);
  assert.equal(entry.handler, "tool-before");
});

/**
 * spec P3 AC6, second clause. `hooks.json` is a shared file, so anything that does not name our launcher belongs
 * to someone else's tooling.
 */
test("a pre-existing foreign hook group survives byte-identical", () => {
  const foreign = {
    hooks: {
      PreToolUse: [
        { matcher: "^Bash$", hooks: [{ type: "command", command: "/opt/audit/log.sh", timeout: 5 }] },
      ],
      SomeOtherEvent: [{ hooks: [{ type: "command", command: "/opt/audit/other.sh", timeout: 9 }] }],
    },
  };
  const merged = mergeCodexHooks(JSON.stringify(foreign, null, 2), wiring.entries);
  assert.ok(merged.ok);
  const hooks = hooksOf(merged.hooksText);
  assert.deepEqual(hooks.SomeOtherEvent, foreign.hooks.SomeOtherEvent);
  assert.deepEqual(hooks.PreToolUse?.[0], foreign.hooks.PreToolUse[0]);
  assert.equal(hooks.PreToolUse?.length, 2, "the foreign group is kept and ours is appended");
});

test("keys the document carries outside hooks are preserved", () => {
  const existing = JSON.stringify({ version: 2, hooks: {} }, null, 2);
  const merged = mergeCodexHooks(existing, wiring.entries);
  assert.ok(merged.ok);
  assert.equal((JSON.parse(merged.hooksText) as { version: number }).version, 2);
});

/**
 * hazard: appending only what is missing leaves a stale copy behind when the launcher path changes, and every
 * hook then fires twice.
 */
test("our own group is replaced wholesale rather than duplicated when the launcher path changes", () => {
  const first = mergeCodexHooks(null, wiring.entries);
  assert.ok(first.ok);
  const moved = codexWiring({ launcherPath: "/opt/tlc/bin/tlc-exec.mjs" });
  const second = mergeCodexHooks(first.hooksText, moved.entries);
  assert.ok(second.ok);
  const groups = hooksOf(second.hooksText).PreToolUse;
  assert.equal(groups?.length, 1);
  assert.match(JSON.stringify(groups), /\/opt\/tlc\/bin\/tlc-exec\.mjs/);
  assert.doesNotMatch(JSON.stringify(groups), /\.tlc\/harness\/bin/);
});

test("re-merging an already-wired document reports no change, so update stays idempotent", () => {
  const first = mergeCodexHooks(null, wiring.entries);
  assert.ok(first.ok);
  assert.equal(first.changed, true);
  const second = mergeCodexHooks(first.hooksText, wiring.entries);
  assert.ok(second.ok);
  assert.equal(second.changed, false);
  assert.equal(second.hooksText, first.hooksText);
});

/**
 * hazard: a `hooks.json` that does not parse breaks the operator's whole host, which is strictly worse than
 * missing steering. It is reported with the block they can paste, and never rewritten.
 */
test("a hooks.json that does not parse is refused with the block to paste, not overwritten", () => {
  const result = mergeCodexHooks("{ not json", wiring.entries);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.block.includes("PreToolUse"));
});

test("a hooks.json whose root is not an object is refused the same way", () => {
  const result = mergeCodexHooks("[1, 2, 3]", wiring.entries);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("not a JSON object"));
});
