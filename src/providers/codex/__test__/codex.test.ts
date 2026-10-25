import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { providerWiringStatus } from "../../../../tools/doctor.ts";
import { withEnv } from "../../../../tools/test-env.scope.mjs";
import { applyUninstall, planUninstall } from "../../../../tools/uninstall-runtime.ts";
import { runHandler } from "../../../entrypoints/run.ts";
import { floorVerdict, toolBeforeHandler } from "../../../entrypoints/tool-before.ts";
import { degrade } from "../../provider.degrade.ts";
import { resolveProvider } from "../../provider.registry.ts";
import { codexToEvent } from "../codex.inbound.ts";
import { codexRender } from "../codex.outbound.ts";
import { applyCodexWiring, codexWiring, mergeCodexHooks } from "../codex.wiring.ts";
import { codexProvider } from "../index.ts";

function payload(hook_event_name: string, extra: Record<string, unknown> = {}) {
  return { _tlc_provider: "codex", hook_event_name, session_id: "s1", cwd: "/tmp/project", ...extra };
}
function event(hook: string, extra: Record<string, unknown> = {}) {
  const result = codexToEvent(payload(hook, extra));
  assert.ok(result);
  return result;
}

test("explicit provider identity disambiguates otherwise identical Claude payloads", () => {
  const raw = payload("SessionStart");
  assert.equal(resolveProvider(raw).provider?.name, "codex");
  assert.equal(resolveProvider(raw).ambiguous, false);
  const { _tlc_provider: _tag, ...untagged } = raw;
  assert.equal(resolveProvider(untagged).provider?.name, "claude");
  for (const bad of [null, undefined, [], 1, "codex", {}]) assert.equal(codexProvider.detect(bad), false);
  assert.equal(codexToEvent({ hook_event_name: "PostToolUseFailure" }), null);
});

test("normalizes shell, MCP output, spawn and stop without reading unstable transcripts", () => {
  const shell = event("PreToolUse", { tool_name: "Bash", tool_input: { command: "git status" } });
  assert.equal(shell.event, "shell.before");
  assert.equal(shell.command, "git status");
  assert.equal(shell.sessionKey, "codex-s1");
  const after = event("PostToolUse", { tool_name: "mcp__test__read", tool_response: { content: [] } });
  assert.equal(after.event, "mcp.after");
  assert.equal(after.toolOutput, '{"content":[]}');
  assert.equal(event("Stop", { last_assistant_message: "done" }).text, "done");
  assert.equal(
    event("PreToolUse", { tool_name: "spawn_agent", tool_input: { agent_type: "reviewer" } })
      .spawnSubagentType,
    "reviewer",
  );
});

test("patch paths include later files, deletes and move destinations", () => {
  const patch =
    "*** Begin Patch\n*** Update File: first.ts\n@@\n-old\n+new\n*** Move to: moved.ts\n*** Delete File: deleted.ts\n*** Add File: last.ts\n+hello\n*** End Patch";
  const result = event("PreToolUse", { tool_name: "apply_patch", tool_input: { command: patch } });
  assert.equal(result.toolName, "Edit");
  assert.deepEqual(
    result.filePaths,
    ["first.ts", "moved.ts", "deleted.ts", "last.ts"].map((path) => resolve("/tmp/project", path)),
  );
});

test("ask degrades to a supported denial, rewrite includes allow, Stop continues with block", () => {
  const pre = event("PreToolUse");
  const denied = degrade({ kind: "ask", reason: "review", rule: "test" }, pre, codexProvider.capabilities());
  assert.equal(denied.kind, "deny");
  const output = JSON.parse(codexRender(denied, pre).stdout ?? "{}");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  const rewritten = JSON.parse(
    codexRender({ kind: "rewriteInput", input: { command: "pwd" }, reason: "test" }, pre).stdout ?? "{}",
  );
  assert.equal(rewritten.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(rewritten.hookSpecificOutput.updatedInput, { command: "pwd" });
  assert.deepEqual(
    JSON.parse(codexRender({ kind: "continue", text: "run tests" }, event("Stop")).stdout ?? "{}"),
    { decision: "block", reason: "run tests" },
  );
  assert.equal(
    degrade({ kind: "context", text: "advice" }, event("Stop"), codexProvider.capabilities()).kind,
    "abstain",
  );
  assert.deepEqual(codexProvider.capabilities().toolOutputRewriteOn, []);
});

test("runtime rejects a protected second patch path, and protects wiring while paused", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-patch-"));
  try {
    mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
    const raw = payload("PreToolUse", {
      cwd: root,
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Add File: okay.ts\n+fine\n*** Add File: .tlc/harness/config.json\n+{}\n*** End Patch",
      },
    });
    const result = await runHandler(
      toolBeforeHandler,
      { readStdin: async () => JSON.stringify(raw) },
      floorVerdict,
    );
    assert.equal(result.decision.kind, "deny");
    assert.match(result.rendered.stdout ?? "", /policy/);
    mkdirSync(join(root, ".tlc", "harness", "state", "flags"), { recursive: true });
    writeFileSync(join(root, ".tlc", "harness", "state", "flags", "skip-verify"), "");
    raw.session_id = "paused-session";
    const wiring = codexWiring({ launcherPath: "unused" });
    (raw as Record<string, unknown>).tool_input = {
      command: `*** Begin Patch\n*** Add File: okay.ts\n+fine\n*** Add File: ${wiring.target}\n+{}\n*** End Patch`,
    };
    const paused = await runHandler(
      toolBeforeHandler,
      { readStdin: async () => JSON.stringify(raw) },
      floorVerdict,
    );
    assert.equal(paused.decision.kind, "deny");
    assert.match(paused.rendered.stdout ?? "", /hook registration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merging and uninstalling preserve foreign handlers, reject invalid documents, and are idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-wiring-"));
  try {
    withEnv({ CODEX_HOME: join(root, "codex") }, () => {
      const wiring = codexWiring({
        launcherPath: join(root, "runtime with 'quotes'", "bin", "tlc-exec.mjs"),
      });
      assert.equal(providerWiringStatus(wiring), "not-installed");
      mkdirSync(join(root, "codex"));
      const foreign = { type: "command", command: "echo foreign" };
      writeFileSync(
        wiring.target,
        JSON.stringify({ description: "mine", hooks: { Stop: [{ hooks: [foreign] }] } }),
      );
      const first = applyCodexWiring(wiring.target, wiring.entries);
      assert.ok(first.ok && first.changed);
      assert.equal(providerWiringStatus(wiring), "wired");
      const again = applyCodexWiring(wiring.target, wiring.entries);
      assert.ok(again.ok && !again.changed);
      const doc = JSON.parse(readFileSync(wiring.target, "utf8"));
      assert.equal(doc.description, "mine");
      assert.deepEqual(doc.hooks.Stop[0].hooks, [foreign]);
      assert.equal(doc.hooks.SessionEnd[0].hooks[0].timeout, 3);
      assert.equal(doc.hooks.PreToolUse[0].hooks[0].args, undefined);
      assert.match(doc.hooks.PreToolUse[0].hooks[0].command, /--provider/);
      const targets = {
        home: join(root, "runtime"),
        binLinks: [],
        skillLinks: [],
        claudeSettings: join(root, "claude.json"),
        cursorHooks: join(root, "cursor.json"),
        codexHooks: wiring.target,
      };
      assert.equal(applyUninstall(planUninstall(targets), targets).failed.length, 0);
      assert.deepEqual(JSON.parse(readFileSync(wiring.target, "utf8")), {
        description: "mine",
        hooks: { Stop: [{ hooks: [foreign] }] },
      });
      for (const invalid of ["{", "[]", '{"hooks": []}', '{"hooks": {"Stop": false}}'])
        assert.equal(mergeCodexHooks(invalid, wiring.entries).ok, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unmerge keeps foreign handlers sharing a group and similarly named provider commands", () => {
  const foreign = { type: "command", command: "node /codex/tlc-exec.mjs stop --provider other" };
  const owned = { type: "command", command: "'node' '/runtime/tlc-exec.mjs' 'stop' '--provider' 'codex'" };
  const result = mergeCodexHooks(
    JSON.stringify({ hooks: { Stop: [{ matcher: "*", hooks: [owned, foreign] }] } }),
  );
  assert.ok(result.ok);
  assert.deepEqual(JSON.parse(result.text), { hooks: { Stop: [{ matcher: "*", hooks: [foreign] }] } });
});
