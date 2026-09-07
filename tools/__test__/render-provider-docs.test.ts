import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProviderCapabilities } from "../../src/contracts/index.ts";
import { providers } from "../../src/providers/provider.registry.ts";
import {
  type ProviderInboundModule,
  renderAll,
  renderCapabilityTable,
  renderEventMappingTable,
} from "../dev/render-provider-docs.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FIXTURE_CAPABILITIES: ProviderCapabilities = {
  enforcesHooks: true,
  askSupportedOn: ["tool.before", "shell.before"],
  sessionEnv: false,
  nativeLoopCounter: true,
  dedicatedShellEvent: false,
  toolInputRewrite: true,
  toolOutputRewriteOn: ["tool.after"],
  contextAtToolBefore: true,
  contextAtToolAfter: false,
  contextAtStop: true,
  sessionStartContextReliable: false,
  toolOutputAtAfter: true,
  usageInPayload: false,
  effortSignal: true,
  thoughtEvent: false,
};

test("renderCapabilityTable renders one row per capability, in declared order, with the fixture's own values", () => {
  const table = renderCapabilityTable(FIXTURE_CAPABILITIES);
  const lines = table.split("\n");
  assert.equal(lines[0], "| Capability | Value |");
  assert.equal(lines[1], "|---|---|");
  assert.equal(lines[2], "| `enforcesHooks` | `true` |");
  assert.equal(lines[3], '| `askSupportedOn` | `["tool.before","shell.before"]` |');
  assert.equal(lines[lines.length - 1], "| `thoughtEvent` | `false` |");
  assert.equal(lines.length, 17); // header + separator + 15 capability fields
});

test("renderEventMappingTable renders a plain 2-column table when no fan-out table is exported", () => {
  const mod: ProviderInboundModule = {
    EVENT_KIND_BY_HOOK: { sessionStart: "session.start", stop: "stop" },
  };
  const table = renderEventMappingTable(mod);
  const lines = table.split("\n");
  assert.equal(lines[0], "| Hook | HarnessEventKind |");
  assert.deepEqual(lines.slice(2), ["| `sessionStart` | `session.start` |", "| `stop` | `stop` |"]);
});

test("renderEventMappingTable renders a 3-column table naming the fan-out rule when a fan-out table is exported", () => {
  const mod: ProviderInboundModule = {
    EVENT_KIND_BY_HOOK: { SessionStart: "session.start" },
    PRE_TOOL_USE_FAN_OUT: [
      { match: "Bash", kind: "shell.before" },
      { match: /^mcp__/, kind: "mcp.before" },
    ],
    POST_TOOL_USE_FAN_OUT: [{ match: "Edit", kind: "edit.after" }],
  };
  const table = renderEventMappingTable(mod);
  const lines = table.split("\n");
  assert.equal(lines[0], "| Hook | Fan-out rule | HarnessEventKind |");
  assert.deepEqual(lines.slice(2), [
    "| `SessionStart` | — | `session.start` |",
    '| `PreToolUse` | tool_name === "Bash" | `shell.before` |',
    "| `PreToolUse` | tool_name matches `^mcp__` | `mcp.before` |",
    '| `PostToolUse` | tool_name === "Edit" | `edit.after` |',
  ]);
});

test("renderAll returns one {file, current, next} result per registered provider", async () => {
  const results = await renderAll();
  assert.equal(results.length, providers.length);
  for (const result of results) {
    assert.equal(typeof result.file, "string");
    assert.equal(typeof result.current, "string");
    assert.equal(typeof result.next, "string");
  }
});

// hazard: at this point in the feature's rollout, neither existing provider doc has the generated marker
// pair yet (that lands in a later task) — so every region replacement here misses its marker. This proves
// that scenario reports the gap on stderr rather than crashing the whole run.
test("--check against provider docs with no marker regions yet reports the gap, and does not crash", () => {
  const result = spawnSync(
    process.execPath,
    [join("tools", "dev", "render-provider-docs.ts"), "--check"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, null, "the process exited rather than crashing with a signal");
  assert.doesNotMatch(result.stderr, /at file:/, "no uncaught exception stack trace on stderr");
  assert.match(result.stderr, /missing region marker/);
});
