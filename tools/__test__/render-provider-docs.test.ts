import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderCapabilities } from "../../src/contracts/index.ts";
import { providers } from "../../src/providers/provider.registry.ts";
import {
  type ProviderInboundModule,
  renderAll,
  renderCapabilityTable,
  renderEventMappingTable,
} from "../dev/render-provider-docs.ts";

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

// why: a provider doc lacking its marker pair is a real, permanent edge case (a provider scaffolded before
// its doc is retrofitted, or a doc regressed by a careless hand-edit) — proven against a scratch fixture
// rather than the repo's own committed docs, so this stays true regardless of their current state.
test("renderAll reports a missing marker per file, and does not crash, rather than throwing", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "render-provider-docs-"));
  const messages: string[] = [];
  const originalError = console.error;
  try {
    mkdirSync(join(scratch, "docs", "providers"), { recursive: true });
    writeFileSync(join(scratch, "docs", "providers", "claude-code.md"), "# no markers here\n", "utf8");
    writeFileSync(join(scratch, "docs", "providers", "cursor.md"), "# no markers here\n", "utf8");

    console.error = (message?: unknown) => {
      messages.push(String(message));
    };
    const results = await renderAll(scratch);

    assert.equal(results.length, providers.length);
    for (const result of results) {
      assert.equal(result.current, result.next, "no marker found, so nothing to replace");
    }
    assert.ok(
      messages.some((message) => message.includes("missing region marker")),
      `expected a reported missing-marker message, got: ${messages.join(" | ")}`,
    );
  } finally {
    console.error = originalError;
    rmSync(scratch, { recursive: true, force: true });
  }
});
