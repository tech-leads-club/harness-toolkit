import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectVSCode, VSCODE_PROVIDER } from "../vscode.detect.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(HERE, "..", "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function fixturesIn(...segments: string[]): { name: string; payload: Record<string, unknown> }[] {
  const dir = join(...segments);
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => ({ name: entry, payload: readJson(join(dir, entry)) }));
}

const vscodeFixtures = fixturesIn(HERE, "fixtures");

const foreignFixtures = [
  ...fixturesIn(PROVIDERS_DIR, "codex", "__test__", "fixtures"),
  ...fixturesIn(PROVIDERS_DIR, "cursor", "__test__", "fixtures"),
  ...fixturesIn(PROVIDERS_DIR, "claude", "__test__", "fixtures"),
  ...fixturesIn(PROVIDERS_DIR, "opencode", "__test__", "fixtures", "legacy"),
  ...fixturesIn(PROVIDERS_DIR, "opencode", "__test__", "fixtures", "namespaced"),
];

function withHint<T>(hint: string | undefined, body: () => T): T {
  const previous = process.env.TLC_PROVIDER_HINT;
  if (hint === undefined) {
    delete process.env.TLC_PROVIDER_HINT;
  } else {
    process.env.TLC_PROVIDER_HINT = hint;
  }
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.TLC_PROVIDER_HINT;
    } else {
      process.env.TLC_PROVIDER_HINT = previous;
    }
  }
}

test("the fixture sets are non-empty, so the sweeps below assert something", () => {
  assert.ok(vscodeFixtures.length > 0);
  assert.ok(foreignFixtures.length > 0);
});

// spec P4 AC1: false for a real VS Code payload with no hint set.
test("no VS Code fixture is claimed with no hint set", () => {
  withHint(undefined, () => {
    for (const { name, payload } of vscodeFixtures) {
      assert.equal(detectVSCode(payload), false, name);
    }
  });
});

/**
 * The payload the whole hint channel exists for: byte-shaped exactly like a Claude Code `PreToolUse`. If this one
 * were claimed by content, every Claude hook would be too.
 */
test("the Claude-shaped PreToolUse fixture is not claimed with no hint set", () => {
  const terminal = vscodeFixtures.find((entry) => entry.name === "pre-tool-use-terminal.json");
  assert.ok(terminal);
  withHint(undefined, () => {
    assert.equal(detectVSCode(terminal.payload), false);
  });
});

test("no other host's fixture is claimed with no hint set", () => {
  withHint(undefined, () => {
    for (const { name, payload } of foreignFixtures) {
      assert.equal(detectVSCode(payload), false, name);
    }
  });
});

// spec P4 AC1: true only when the provider hint is `vscode`.
test("every VS Code fixture is claimed once the hint names vscode", () => {
  withHint(VSCODE_PROVIDER, () => {
    for (const { name, payload } of vscodeFixtures) {
      assert.equal(detectVSCode(payload), true, name);
    }
  });
});

test("a hint naming another host does not claim a VS Code payload", () => {
  const terminal = vscodeFixtures.find((entry) => entry.name === "pre-tool-use-terminal.json");
  assert.ok(terminal);
  for (const hint of ["claude", "codex", "cursor", "opencode-legacy", ""]) {
    withHint(hint, () => {
      assert.equal(detectVSCode(terminal.payload), false, hint);
    });
  }
});

// why: `TLC_PROVIDER_HINT` reaches the child through a launcher argument, and a trailing newline or space there is
// an install-time typo, not a different host.
test("surrounding whitespace in the hint is trimmed rather than refused", () => {
  withHint("  vscode\n", () => {
    assert.equal(detectVSCode({ hook_event_name: "SessionStart", cwd: "/repo" }), true);
  });
});

test("non-objects are rejected rather than thrown on, even while the hint names vscode", () => {
  withHint(VSCODE_PROVIDER, () => {
    for (const raw of [null, undefined, 0, "PreToolUse", true, [], [{ tool_name: "readFile" }]]) {
      assert.equal(detectVSCode(raw), false, JSON.stringify(raw ?? null));
    }
  });
});

test("the provider name is the hint token itself", () => {
  assert.equal(VSCODE_PROVIDER, "vscode");
});
