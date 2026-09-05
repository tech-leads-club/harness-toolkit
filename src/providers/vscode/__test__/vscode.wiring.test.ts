import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyProviderWiring, providerHomeDir } from "../../../../bin/write-user-hooks.mjs";
import { copilotConfigDir } from "../../../platform/paths.ts";
import { providers } from "../../provider.registry.ts";
import {
  isDeferredWiringKind,
  renderVSCodeHooksText,
  VSCODE_DEFERRAL_REASON,
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
 * spec P4 AC5: the installer's dispatch takes an explicit deferral branch and writes no file.
 *
 * why the target is asserted as still absent: "returns deferred" and "wrote nothing" are different claims, and
 * only the second is the criterion.
 */
test("the installer defers instead of writing, and creates nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "vscode-wiring-"));
  try {
    const target = join(root, "hooks", "tlc-harness.json");
    const result = applyProviderWiring({ ...wiring, target });
    assert.equal(result.status, "deferred");
    assert.equal(result.reason, VSCODE_DEFERRAL_REASON);
    assert.equal(result.target, target);
    assert.equal(existsSync(target), false, "the wiring file must not be written");
    assert.equal(existsSync(join(root, "hooks")), false, "not even its directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the deferral reason says what is deferred and why, without claiming the adapter is missing", () => {
  assert.match(VSCODE_DEFERRAL_REASON, /Preview/);
  assert.match(VSCODE_DEFERRAL_REASON, /nothing is written/);
  assert.match(VSCODE_DEFERRAL_REASON, /ad-126/);
});

test("the deferral is keyed to the wiring kind, so no other host is caught by it", () => {
  assert.equal(isDeferredWiringKind("vscode-hooks-json"), true);
  for (const provider of providers) {
    if (provider.name === "vscode") {
      continue;
    }
    assert.equal(
      isDeferredWiringKind(provider.wiring({ launcherPath: LAUNCHER }).kind),
      false,
      provider.name,
    );
  }
});

/**
 * why the host directory is one level above the target: `~/.copilot/hooks` is a directory this writer would
 * create, so its absence says nothing about whether VS Code is installed — the same shape as the namespaced
 * opencode plugin ([/decisions/ad-124.md](/decisions/ad-124.md)).
 */
test("host presence is asked of ~/.copilot, not of the hooks directory this writer would create", () => {
  assert.equal(providerHomeDir(wiring), copilotConfigDir());
});

test("the adapter is registered, and sits ahead of Claude", () => {
  const names = providers.map((provider) => provider.name);
  assert.ok(names.includes("vscode"), names.join(","));
  assert.ok(names.indexOf("vscode") < names.indexOf("claude"), names.join(","));
});
