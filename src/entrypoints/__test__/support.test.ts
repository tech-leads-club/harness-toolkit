import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { HarnessEvent } from "../../contracts/index.ts";
import { providers } from "../../providers/index.ts";
import { renderProviderLessonsView, shaScopeRoot } from "../support.ts";

const BASE_EVENT: HarnessEvent = {
  provider: "claude",
  event: "shell.before",
  sessionKey: "claude-probe",
  projectDir: "/main-checkout",
  raw: {},
};

// why: this precedence is the entire AD-114 fix — `event.cwd` is the field the host actually moves
// into a worktree, `event.projectDir` is the one that deliberately does not.
test("shaScopeRoot prefers event.cwd over event.projectDir when both are present", () => {
  const event: HarnessEvent = { ...BASE_EVENT, cwd: "/main-checkout/.claude/worktrees/feature-x" };
  assert.equal(shaScopeRoot(event), "/main-checkout/.claude/worktrees/feature-x");
});

test("shaScopeRoot falls back to event.projectDir when cwd is absent", () => {
  assert.equal(shaScopeRoot(BASE_EVENT), "/main-checkout");
});

test("shaScopeRoot returns projectDir unchanged when cwd equals it", () => {
  const event: HarnessEvent = { ...BASE_EVENT, cwd: "/main-checkout" };
  assert.equal(shaScopeRoot(event), "/main-checkout");
});

/**
 * spec P4 AC7. `durableViewVerdict` decides *whether* a durable view is written; this dispatcher decides *which*
 * file. Returning null for a host meant `syncRulesFile: "always"` silently did nothing there.
 */
test("renderProviderLessonsView routes every registered provider to a view", () => {
  const root = mkdtempSync(join(tmpdir(), "lessons-dispatch-"));
  try {
    const source = join(root, ".tlc", "harness", "lessons.md");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "- always run the gate\n", "utf8");

    const routed = new Map(
      providers.map((provider) => [provider.name, renderProviderLessonsView(provider.name, root)]),
    );

    assert.equal(routed.get("codex"), join(root, "AGENTS.md"));
    assert.equal(routed.get("vscode"), join(root, ".github", "copilot-instructions.md"));
    for (const [name, path] of routed) {
      assert.notEqual(path, null, `${name} has no durable view`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
