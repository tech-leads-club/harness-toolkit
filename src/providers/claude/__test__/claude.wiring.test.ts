import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeConfigDir } from "../../../platform/paths.ts";
import {
  applyClaudeWiring,
  canonicalizeGroups,
  canonicalLauncherPath,
  claudeSettingsPath,
  claudeWiring,
  mergeClaudeSettings,
  removeClaudeWiring,
  unmergeClaudeSettings,
} from "../claude.wiring.ts";

const RUNTIME = { launcherPath: "/opt/tlc/bin/tlc-exec.mjs" };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "tlc-claude-wiring-test-"));
}

test("target is the resolved claude config dir with the merge strategy", () => {
  const wiring = claudeWiring(RUNTIME);
  assert.equal(wiring.target, claudeSettingsPath());
  assert.equal(wiring.target, join(claudeConfigDir(), "settings.json"));
  assert.equal(wiring.strategy, "merge");
});

test("PreToolUse is registered exactly once — a single dispatcher, not one per tool", () => {
  const wiring = claudeWiring(RUNTIME);
  const preToolUseEntries = wiring.entries.filter((e) => e.hookEvent === "PreToolUse");
  assert.equal(preToolUseEntries.length, 1);
});

test("PostToolUse is also registered exactly once", () => {
  const wiring = claudeWiring(RUNTIME);
  const postToolUseEntries = wiring.entries.filter((e) => e.hookEvent === "PostToolUse");
  assert.equal(postToolUseEntries.length, 1);
});

test("every entry uses exec form — command node, args starting with the launcher path", () => {
  const wiring = claudeWiring(RUNTIME);
  for (const entry of wiring.entries) {
    assert.equal(entry.command, "node");
    assert.equal(entry.args[0], RUNTIME.launcherPath);
    assert.ok(entry.args.length >= 2);
  }
});

test("Stop keeps a 120-second timeout and loopLimit of 5", () => {
  const wiring = claudeWiring(RUNTIME);
  const stop = wiring.entries.find((e) => e.hookEvent === "Stop");
  assert.equal(stop?.timeoutSeconds, 120);
  assert.equal(stop?.loopLimit, 5);
});

test("PreToolUse and SubagentStart carry failClosed: true", () => {
  const wiring = claudeWiring(RUNTIME);
  const preToolUse = wiring.entries.find((e) => e.hookEvent === "PreToolUse");
  const subagentStart = wiring.entries.find((e) => e.hookEvent === "SubagentStart");
  assert.equal(preToolUse?.failClosed, true);
  assert.equal(subagentStart?.failClosed, true);
});

test("SessionStart carries no failClosed", () => {
  const wiring = claudeWiring(RUNTIME);
  const sessionStart = wiring.entries.find((e) => e.hookEvent === "SessionStart");
  assert.equal(sessionStart?.failClosed, undefined);
});

test("mergeClaudeSettings with no existing file creates the hooks section from scratch", () => {
  const wiring = claudeWiring(RUNTIME);
  const result = mergeClaudeSettings(null, wiring.entries);
  assert.equal(result.ok, true);
  if (result.ok) {
    const parsed = JSON.parse(result.settingsText);
    assert.ok(Array.isArray(parsed.hooks.PreToolUse));
    assert.equal(result.changed, true);
  }
});

test("merge preserves every unrelated top-level key's value", () => {
  const existing = JSON.stringify({ theme: "dark", editorFontSize: 14 });
  const wiring = claudeWiring(RUNTIME);
  const result = mergeClaudeSettings(existing, wiring.entries);
  assert.equal(result.ok, true);
  if (result.ok) {
    const parsed = JSON.parse(result.settingsText);
    assert.equal(parsed.theme, "dark");
    assert.equal(parsed.editorFontSize, 14);
  }
});

test("merge preserves a pre-existing non-harness entry under a hook key we also manage", () => {
  const thirdParty = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "sh", args: ["-c", "echo hi"] }] }],
    },
  };
  const wiring = claudeWiring(RUNTIME);
  const result = mergeClaudeSettings(JSON.stringify(thirdParty), wiring.entries);
  assert.equal(result.ok, true);
  if (result.ok) {
    const parsed = JSON.parse(result.settingsText);
    assert.equal(parsed.hooks.PreToolUse.length, 2);
    assert.deepEqual(parsed.hooks.PreToolUse[0], thirdParty.hooks.PreToolUse[0]);
  }
});

test("merge preserves a pre-existing non-harness hook key entirely", () => {
  const thirdParty = {
    hooks: { Notification: [{ hooks: [{ type: "command", command: "notify-send", args: [] }] }] },
  };
  const wiring = claudeWiring(RUNTIME);
  const result = mergeClaudeSettings(JSON.stringify(thirdParty), wiring.entries);
  assert.equal(result.ok, true);
  if (result.ok) {
    const parsed = JSON.parse(result.settingsText);
    assert.deepEqual(parsed.hooks.Notification, thirdParty.hooks.Notification);
  }
});

test("merging an already-present identical entry is a no-op", () => {
  const wiring = claudeWiring(RUNTIME);
  const first = mergeClaudeSettings(null, wiring.entries);
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }
  const second = mergeClaudeSettings(first.settingsText, wiring.entries);
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.changed, false);
    assert.equal(JSON.parse(second.settingsText).hooks.PreToolUse.length, 1);
  }
});

test("malformed JSON returns an error result carrying the parse message and a pasteable block", () => {
  const result = mergeClaudeSettings("{ not valid json", claudeWiring(RUNTIME).entries);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.length > 0);
    assert.ok(result.block.includes("PreToolUse"));
  }
});

test("a JSON array root is rejected as an error rather than merged into", () => {
  const result = mergeClaudeSettings("[]", claudeWiring(RUNTIME).entries);
  assert.equal(result.ok, false);
});

test("applyClaudeWiring writes a fresh settings.json when none exists", () => {
  const dir = tempDir();
  const settingsPath = join(dir, ".claude", "settings.json");
  try {
    const result = applyClaudeWiring(settingsPath, claudeWiring(RUNTIME).entries);
    assert.equal(result.ok, true);
    assert.equal(existsSync(settingsPath), true);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.ok(Array.isArray(written.hooks.Stop));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyClaudeWiring on malformed settings.json performs no write", () => {
  const dir = tempDir();
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, "{ this is not json", "utf8");
  try {
    const before = readFileSync(settingsPath, "utf8");
    const result = applyClaudeWiring(settingsPath, claudeWiring(RUNTIME).entries);
    assert.equal(result.ok, false);
    const after = readFileSync(settingsPath, "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyClaudeWiring is idempotent — re-running does not change file content", () => {
  const dir = tempDir();
  const settingsPath = join(dir, "settings.json");
  try {
    applyClaudeWiring(settingsPath, claudeWiring(RUNTIME).entries);
    const firstContent = readFileSync(settingsPath, "utf8");
    const second = applyClaudeWiring(settingsPath, claudeWiring(RUNTIME).entries);
    const secondContent = readFileSync(settingsPath, "utf8");
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.changed, false);
    }
    assert.equal(secondContent, firstContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// hazard: the install path is a symlink in every from-a-clone setup, so settings.json holds one path while
// the runtime resolves another. A structural comparison called that wiring broken on every doctor run and
// rewrote a correct settings.json on every update.
test("a launcher reached through a symlink is recognised as the same wiring", () => {
  const dir = mkdtempSync(join(tmpdir(), "tlc-wiring-link-"));
  try {
    const real = join(dir, "checkout");
    mkdirSync(join(real, "bin"), { recursive: true });
    writeFileSync(join(real, "bin", "tlc-exec.mjs"), "");
    const link = join(dir, "installed");
    try {
      symlinkSync(real, link, "dir");
    } catch {
      return;
    }
    const viaLink = mergeClaudeSettings(
      null,
      claudeWiring({ launcherPath: join(link, "bin", "tlc-exec.mjs") }).entries,
    );
    assert.equal(viaLink.ok, true);
    const settingsFromLink = viaLink.ok ? viaLink.settingsText : "";

    const viaReal = mergeClaudeSettings(
      settingsFromLink,
      claudeWiring({ launcherPath: join(real, "bin", "tlc-exec.mjs") }).entries,
    );
    assert.equal(viaReal.ok, true);
    assert.equal(viaReal.ok && viaReal.changed, false, "the same file through two paths is one wiring");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a launcher at a genuinely different location is still a change", () => {
  const first = mergeClaudeSettings(null, claudeWiring({ launcherPath: "/one/bin/tlc-exec.mjs" }).entries);
  const settingsText = first.ok ? first.settingsText : "";
  const second = mergeClaudeSettings(
    settingsText,
    claudeWiring({ launcherPath: "/two/bin/tlc-exec.mjs" }).entries,
  );
  assert.equal(second.ok && second.changed, true);
});

test("canonicalLauncherPath falls back to the literal path when it cannot be resolved", () => {
  assert.equal(
    canonicalLauncherPath("/absent/bin/tlc-exec.mjs", () => {
      throw new Error("ENOENT");
    }),
    "/absent/bin/tlc-exec.mjs",
  );
});

test("canonicalizeGroups only rewrites strings naming the launcher", () => {
  const groups = [
    { hooks: [{ type: "command", command: "node", args: ["/link/bin/tlc-exec.mjs", "stop"] }] },
    { hooks: [{ type: "command", command: "bash /somebody/else/script.sh" }] },
  ];
  const canonical = canonicalizeGroups(groups, () => "/real/bin/tlc-exec.mjs") as typeof groups;
  assert.equal(JSON.stringify(canonical).includes("/real/bin/tlc-exec.mjs"), true);
  assert.equal(JSON.stringify(canonical).includes("/somebody/else/script.sh"), true);
});

test("unmerge drops our group and keeps a foreign one registered on the same event", () => {
  const merged = mergeClaudeSettings(
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "bash", args: ["/home/me/notify.sh"] }] }],
      },
    }),
    claudeWiring(RUNTIME).entries,
  );
  assert.equal(merged.ok, true);
  assert.equal(merged.ok && merged.settingsText.includes("tlc-exec.mjs"), true);

  const undone = unmergeClaudeSettings(merged.ok ? merged.settingsText : "");
  assert.equal(undone.ok, true);
  assert.equal(undone.ok && undone.changed, true);
  const settings = JSON.parse(undone.ok ? undone.settingsText : "{}");
  assert.equal(JSON.stringify(settings).includes("tlc-exec.mjs"), false);
  assert.deepEqual(settings.hooks.Stop, [
    { hooks: [{ type: "command", command: "bash", args: ["/home/me/notify.sh"] }] },
  ]);
});

test("unmerge preserves every key the harness never wrote", () => {
  const operator = {
    defaultMode: "bypassPermissions",
    permissions: { deny: ["Read(./secrets/**)"] },
    sandbox: { enabled: true },
    statusLine: { type: "command", command: "my-statusline" },
  };
  const merged = mergeClaudeSettings(JSON.stringify(operator), claudeWiring(RUNTIME).entries);
  const undone = unmergeClaudeSettings(merged.ok ? merged.settingsText : "");
  assert.equal(undone.ok, true);
  assert.deepEqual(JSON.parse(undone.ok ? undone.settingsText : "{}"), operator);
});

test("unmerge removes the hook event key rather than leaving an empty array", () => {
  const merged = mergeClaudeSettings(null, claudeWiring(RUNTIME).entries);
  const undone = unmergeClaudeSettings(merged.ok ? merged.settingsText : "");
  const settings = JSON.parse(undone.ok ? undone.settingsText : "{}");
  assert.equal("hooks" in settings, false);
});

test("unmerge is idempotent — the second pass reports nothing changed", () => {
  const merged = mergeClaudeSettings(JSON.stringify({ env: { A: "1" } }), claudeWiring(RUNTIME).entries);
  const first = unmergeClaudeSettings(merged.ok ? merged.settingsText : "");
  assert.equal(first.ok && first.changed, true);
  const second = unmergeClaudeSettings(first.ok ? first.settingsText : "");
  assert.equal(second.ok && second.changed, false);
});

test("unmerge refuses a settings.json it cannot parse instead of overwriting it", () => {
  const result = unmergeClaudeSettings("{ this is not json");
  assert.equal(result.ok, false);
});

test("removeClaudeWiring rewrites the file on disk and is safe to run twice", () => {
  const dir = tempDir();
  const path = join(dir, "settings.json");
  const merged = mergeClaudeSettings(JSON.stringify({ env: { A: "1" } }), claudeWiring(RUNTIME).entries);
  writeFileSync(path, merged.ok ? merged.settingsText : "");

  const first = removeClaudeWiring(path);
  assert.equal(first.ok && first.changed, true);
  assert.equal(readFileSync(path, "utf8").includes("tlc-exec.mjs"), false);
  const second = removeClaudeWiring(path);
  assert.equal(second.ok && second.changed, false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { env: { A: "1" } });
  rmSync(dir, { recursive: true, force: true });
});

test("removeClaudeWiring on an absent file is not an error", () => {
  const result = removeClaudeWiring(join(tempDir(), "settings.json"));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.changed, false);
});
