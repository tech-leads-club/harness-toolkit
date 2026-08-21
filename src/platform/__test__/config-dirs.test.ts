import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withEnv as scopedEnv } from "../../../tools/test-env.scope.mjs";
import { claudeConfigDir, cursorConfigDir } from "../paths.ts";

// why a wrapper and not the shared helper directly: this file's callers pass one name, and rewriting every call
// site to pass an object would be churn for no reading gained ([/decisions/ad-102.md](/decisions/ad-102.md)).
function withEnv(name: string, value: string | undefined, run: () => void): void {
  scopedEnv({ [name]: value }, run);
}

test("CLAUDE_CONFIG_DIR wins over the default location", () => {
  withEnv("CLAUDE_CONFIG_DIR", "/home/x/.claude-alt", () => {
    assert.equal(claudeConfigDir(), "/home/x/.claude-alt");
  });
});

test("an unset or blank CLAUDE_CONFIG_DIR falls back to ~/.claude", () => {
  withEnv("CLAUDE_CONFIG_DIR", undefined, () => {
    assert.equal(claudeConfigDir(), join(homedir(), ".claude"));
  });
  withEnv("CLAUDE_CONFIG_DIR", "   ", () => {
    assert.equal(claudeConfigDir(), join(homedir(), ".claude"));
  });
});

test("CURSOR_CONFIG_DIR behaves the same way", () => {
  withEnv("CURSOR_CONFIG_DIR", "/home/x/.cursor-alt", () => {
    assert.equal(cursorConfigDir(), "/home/x/.cursor-alt");
  });
  withEnv("CURSOR_CONFIG_DIR", undefined, () => {
    assert.equal(cursorConfigDir(), join(homedir(), ".cursor"));
  });
});

// hazard: the expected value has to be built with join too. Hard-coding a POSIX path made this pass
// everywhere except Windows, where join correctly returns backslashes and the product was not wrong.
test("provider wiring targets follow the resolved config dir", async () => {
  const { claudeWiring } = await import("../../providers/claude/claude.wiring.ts");
  const { cursorWiring } = await import("../../providers/cursor/cursor.wiring.ts");
  const runtime = { launcherPath: "/opt/tlc/bin/tlc-exec.mjs" };
  const claudeDir = join("/home", "x", ".claude-alt");
  const cursorDir = join("/home", "x", ".cursor-alt");
  withEnv("CLAUDE_CONFIG_DIR", claudeDir, () => {
    assert.equal(claudeWiring(runtime).target, join(claudeDir, "settings.json"));
  });
  withEnv("CURSOR_CONFIG_DIR", cursorDir, () => {
    assert.equal(cursorWiring(runtime).target, join(cursorDir, "hooks.json"));
  });
});
