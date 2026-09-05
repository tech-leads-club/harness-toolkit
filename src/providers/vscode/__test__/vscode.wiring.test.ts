import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyProviderWiring } from "../../../../bin/write-user-hooks.mjs";
import type { WiringEntry } from "../../../contracts/index.ts";
import { copilotConfigDir } from "../../../platform/paths.ts";
import {
  isVSCodeManaged,
  renderVSCodeHooksText,
  vscodeCommandString,
  vscodeHooksPath,
  vscodeWiring,
} from "../vscode.wiring.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** why a fixed path: the golden file has to be the same bytes on every machine that runs this suite. */
const LAUNCHER = "/opt/tlc/bin/tlc-exec.mjs";

const wiring = vscodeWiring({ launcherPath: LAUNCHER });

test("the wiring declares the vscode-hooks-json kind and replaces its target", () => {
  assert.equal(wiring.kind, "vscode-hooks-json");
  assert.equal(wiring.strategy, "replace");
});

// design §8: the target is `~/.copilot/hooks/tlc-harness.json`.
test("the target is the user-level Copilot hooks file", () => {
  assert.equal(wiring.target, join(copilotConfigDir(), "hooks", "tlc-harness.json"));
  assert.equal(wiring.target, vscodeHooksPath());
});

/**
 * invariant: every entry carries `--provider vscode`. This host has no content fingerprint — its payload is
 * Claude's byte for byte — so the hint in these arguments is the only thing that routes a hook here.
 */
test("every entry launches with the provider hint", () => {
  assert.ok(wiring.entries.length > 0);
  for (const entry of wiring.entries) {
    assert.equal(entry.command, "node");
    assert.deepEqual(entry.args.slice(0, 3), [LAUNCHER, "--provider", "vscode"]);
    assert.equal(entry.args[3], entry.handler);
  }
});

/**
 * invariant: VS Code's documented event list and nothing else. `SessionEnd`, `PostToolUseFailure` and
 * `MessageDisplay` belong to the host whose payload shape this reuses, and wiring them would register hooks
 * VS Code never fires ([/decisions/ad-125.md](/decisions/ad-125.md)).
 */
test("the entries name exactly the events VS Code documents", () => {
  assert.deepEqual(
    wiring.entries.map((entry) => entry.hookEvent).sort(),
    [
      "PreCompact",
      "PreToolUse",
      "PostToolUse",
      "SessionStart",
      "Stop",
      "SubagentStart",
      "SubagentStop",
      "UserPromptSubmit",
    ].sort(),
  );
});

test("no entry names an event VS Code does not document", () => {
  const events = wiring.entries.map((entry) => entry.hookEvent);
  for (const absent of ["SessionEnd", "PostToolUseFailure", "MessageDisplay", "PermissionRequest"]) {
    assert.ok(!events.includes(absent), absent);
  }
});

// the golden file, byte for byte. Regenerating it is a deliberate act, which is the point of having one.
test("the rendered document matches the golden file", () => {
  const golden = readFileSync(join(HERE, "golden", "vscode-hooks.json"), "utf8");
  assert.equal(renderVSCodeHooksText(wiring.entries), golden);
});

/**
 * The published schema, asserted directly rather than only through the golden bytes: each event maps to a flat
 * array of command objects, `command` is one shell line, and there is no group wrapper and no `args` key
 * (<https://code.visualstudio.com/docs/agents/reference/hooks-reference>, read 2026-09-05).
 */
test("each event maps to a flat array of command objects, with command a single string", () => {
  const document = JSON.parse(renderVSCodeHooksText(wiring.entries)) as {
    hooks: Record<string, Record<string, unknown>[]>;
  };
  assert.deepEqual(Object.keys(document.hooks).sort(), wiring.entries.map((e) => e.hookEvent).sort());
  for (const [hookEvent, commands] of Object.entries(document.hooks)) {
    assert.equal(commands.length, 1, hookEvent);
    const command = commands[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(command).sort(), ["command", "timeout", "type"]);
    assert.equal(command.type, "command");
    assert.equal(typeof command.command, "string");
    assert.match(command.command as string, /^node \/opt\/tlc\/bin\/tlc-exec\.mjs --provider vscode \S+$/);
    assert.equal(typeof command.timeout, "number");
  }
});

/**
 * why no `matcher` is emitted: quoted verbatim from the reference — "Currently, VS Code ignores matcher values,
 * so hooks run on all tool invocations regardless of the matcher".
 */
test("no entry carries a matcher, on either side of the render", () => {
  const rendered = renderVSCodeHooksText(wiring.entries);
  assert.ok(!rendered.includes("matcher"), rendered);
  for (const entry of wiring.entries) {
    assert.equal(entry.matcher, undefined, entry.hookEvent);
  }
});

/** invariant: a launcher path with a space in it stays one token on the command line. */
test("a path carrying a space is quoted into a single token", () => {
  const spaced = vscodeWiring({ launcherPath: "/Users/a b/.tlc/bin/tlc-exec.mjs" });
  assert.equal(
    vscodeCommandString(spaced.entries[0] as WiringEntry),
    'node "/Users/a b/.tlc/bin/tlc-exec.mjs" --provider vscode session-start',
  );
});

/** why the per-event timeout is emitted on every entry: the documented default is 30 seconds. */
test("every entry carries its own timeout rather than falling to the documented default of 30", () => {
  const document = JSON.parse(renderVSCodeHooksText(wiring.entries)) as {
    hooks: Record<string, { timeout: number }[]>;
  };
  assert.equal(document.hooks.Stop?.[0]?.timeout, 120);
  assert.equal(document.hooks.UserPromptSubmit?.[0]?.timeout, 5);
});

/**
 * spec P4 AC5: the installer's dispatch takes an explicit deferral branch and writes no file.
 *
 * why the target is asserted as still absent: "returns deferred" and "wrote nothing" are different claims, and
 * only the second is the criterion.
 */
test("the installer writes the hook file and creates its directory", () => {
  const root = mkdtempSync(join(tmpdir(), "vscode-wiring-"));
  try {
    const target = join(root, "hooks", "tlc-harness.json");
    const result = applyProviderWiring({ ...wiring, target });
    assert.equal(result.status, "written");
    assert.equal(result.target, target);
    assert.equal(existsSync(target), true);
    assert.equal(readFileSync(target, "utf8"), renderVSCodeHooksText(wiring.entries));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hook file this harness did not write is refused, and left byte-identical", () => {
  const root = mkdtempSync(join(tmpdir(), "vscode-wiring-"));
  try {
    const target = join(root, "hooks", "tlc-harness.json");
    mkdirSync(join(root, "hooks"), { recursive: true });
    const theirs =
      '{\n  "hooks": {\n    "PreToolUse": [{ "type": "command", "command": "their-tool" }]\n  }\n}\n';
    writeFileSync(target, theirs);
    const result = applyProviderWiring({ ...wiring, target });
    assert.equal(result.status, "refused");
    assert.equal(readFileSync(target, "utf8"), theirs);
    assert.equal(applyProviderWiring({ ...wiring, target }, { force: true }).status, "written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rewriting our own unchanged hook file reports unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "vscode-wiring-"));
  try {
    const target = join(root, "hooks", "tlc-harness.json");
    assert.equal(applyProviderWiring({ ...wiring, target }).status, "written");
    assert.equal(applyProviderWiring({ ...wiring, target }).status, "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownership is decided by the launcher every command names, not by a field of our own", () => {
  const wiring = vscodeWiring({ launcherPath: LAUNCHER });
  const ours = renderVSCodeHooksText(wiring.entries);
  assert.equal(isVSCodeManaged(ours, LAUNCHER), true);
  assert.equal(isVSCodeManaged('{"hooks":{"PreToolUse":[{"command":"other"}]}}', LAUNCHER), false);
  assert.equal(isVSCodeManaged("not json", LAUNCHER), false);
  assert.equal(isVSCodeManaged(null, LAUNCHER), false);
  assert.equal(isVSCodeManaged('{"hooks":{}}', LAUNCHER), false);
});
