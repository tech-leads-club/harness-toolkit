import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { opencodeLegacyWiring, opencodeNamespacedWiring, renderOpencodePlugin } from "../opencode.wiring.ts";

/**
 * why a real child process: the bridge's contract with the harness is a launcher invocation with the envelope on
 * stdin and a decision on stdout. Stubbing the call would test the applying half and leave the pipe — the part
 * that has to survive being written into a file the host loads — unasserted.
 */
function scaffold(): { dir: string; launcher: string; payloadLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "tlc-opencode-bridge-"));
  const launcher = join(dir, "fake-launcher.mjs");
  const payloadLog = join(dir, "payload.json");
  writeFileSync(
    launcher,
    `import { readFileSync, writeFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(payloadLog)}, stdin);
process.stdout.write(process.env.FAKE_DECISION ?? "");
`,
  );
  return { dir, launcher, payloadLog };
}

function withDecision<T>(decision: string, run: () => T): T {
  const previous = process.env.FAKE_DECISION;
  process.env.FAKE_DECISION = decision;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.FAKE_DECISION;
    } else {
      process.env.FAKE_DECISION = previous;
    }
  }
}

async function loadLegacyHooks(launcher: string, dir: string): Promise<Record<string, LegacyHook>> {
  const wiring = opencodeLegacyWiring({ launcherPath: launcher });
  const file = join(dir, "tlc-harness.js");
  writeFileSync(file, renderOpencodePlugin(wiring) ?? "");
  const module = (await import(pathToFileURL(file).href)) as {
    TlcHarness: () => Promise<Record<string, LegacyHook>>;
  };
  return await module.TlcHarness();
}

type LegacyHook = (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void> | void;
type NamespacedHook = (event: Record<string, unknown>) => Promise<void> | void;

/**
 * why a stub package rather than a rewritten module: the namespaced bridge is only correct if the file opencode
 * loads is the file this test runs, import statement included. Resolving `@opencode-ai/plugin` from a node_modules
 * beside the emitted module runs the emitted text verbatim.
 */
async function loadNamespacedHooks(launcher: string, dir: string): Promise<Record<string, NamespacedHook>> {
  const pluginDir = join(dir, "tlc-harness");
  const stubDir = join(pluginDir, "node_modules", "@opencode-ai", "plugin");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, "package.json"),
    JSON.stringify({ name: "@opencode-ai/plugin", version: "0.0.0", type: "module", main: "index.js" }),
  );
  writeFileSync(join(stubDir, "index.js"), "export const Plugin = { define: (definition) => definition };\n");

  const wiring = opencodeNamespacedWiring({ launcherPath: launcher });
  const file = join(pluginDir, "index.ts");
  writeFileSync(file, renderOpencodePlugin(wiring) ?? "");

  const module = (await import(pathToFileURL(file).href)) as {
    default: { id: string; setup: (ctx: unknown) => Promise<void> };
  };
  const hooks: Record<string, NamespacedHook> = {};
  const register = (domain: string) => (name: string, handler: NamespacedHook) => {
    hooks[`${domain}.${name}`] = handler;
  };
  await module.default.setup({
    tool: { hook: register("tool") },
    shell: { hook: register("shell") },
    permission: { hook: register("permission") },
  });
  assert.equal(module.default.id, "tlc-harness");
  return hooks;
}

test("legacy: a deny decision round-trips over stdin and stdout and blocks the tool", async () => {
  const { dir, launcher, payloadLog } = scaffold();
  const hooks = await loadLegacyHooks(launcher, dir);
  await withDecision(JSON.stringify({ kind: "deny", reason: "no rm -rf", rule: "shell-guard" }), async () => {
    await assert.rejects(
      async () =>
        await hooks["tool.execute.before"]?.(
          { sessionID: "ses_1", tool: "bash", args: { command: "rm -rf /" } },
          { args: { command: "rm -rf /" } },
        ),
      /no rm -rf/,
    );
  });

  // invariant: what reached the launcher is the envelope both the detector and the parser read.
  const sent = JSON.parse(readFileSync(payloadLog, "utf8")) as Record<string, unknown>;
  assert.equal(sent.provider, "opencode");
  assert.equal(sent.pluginApi, "legacy");
  assert.equal(sent.hook, "tool.execute.before");
  assert.equal(sent.sessionID, "ses_1");
  assert.equal(sent.tool, "bash");
});

test("legacy: a rewrite merges into the tool arguments the host will run", async () => {
  const { dir, launcher } = scaffold();
  const hooks = await loadLegacyHooks(launcher, dir);
  const output = { args: { command: "npm test" } };
  await withDecision(
    JSON.stringify({ kind: "rewriteInput", input: { command: "npm test -- --run" }, reason: "pin" }),
    async () => {
      await hooks["tool.execute.before"]?.({ sessionID: "ses_1", tool: "bash" }, output);
    },
  );
  assert.deepEqual(output.args, { command: "npm test -- --run" });
});

test("legacy: a context decision appends rather than replacing what is already there", async () => {
  const { dir, launcher } = scaffold();
  const hooks = await loadLegacyHooks(launcher, dir);
  const output: Record<string, unknown> = { args: {}, context: "existing" };
  await withDecision(JSON.stringify({ kind: "context", text: "added" }), async () => {
    await hooks["tool.execute.before"]?.({ sessionID: "ses_1", tool: "read" }, output);
  });
  assert.equal(output.context, "existing\nadded");
});

test("legacy: empty stdout is a no-op, so a harness that cannot answer never stops the turn", async () => {
  const { dir, launcher } = scaffold();
  const hooks = await loadLegacyHooks(launcher, dir);
  const output = { args: { command: "ls" }, context: "" };
  await withDecision("", async () => {
    await hooks["tool.execute.before"]?.({ sessionID: "ses_1", tool: "bash" }, output);
  });
  assert.deepEqual(output, { args: { command: "ls" }, context: "" });
});

test("legacy: unparseable stdout is swallowed rather than thrown", async () => {
  const { dir, launcher } = scaffold();
  const hooks = await loadLegacyHooks(launcher, dir);
  const output = { args: {} };
  await withDecision("not json at all", async () => {
    await hooks["tool.execute.before"]?.({ sessionID: "ses_1", tool: "bash" }, output);
  });
  assert.deepEqual(output.args, {});
});

test("legacy: the after hook reports and mutates nothing", async () => {
  const { dir, launcher, payloadLog } = scaffold();
  const hooks = await loadLegacyHooks(launcher, dir);
  const output = { args: { command: "npm test" } };
  await withDecision(JSON.stringify({ kind: "context", text: "ignored" }), async () => {
    await hooks["tool.execute.after"]?.({ sessionID: "ses_1", tool: "bash" }, output);
  });
  assert.deepEqual(output, { args: { command: "npm test" } });
  assert.equal((JSON.parse(readFileSync(payloadLog, "utf8")) as { hook: string }).hook, "tool.execute.after");
});

test("legacy: the bridge registers the two hooks the legacy API documents and no others", async () => {
  const { dir, launcher } = scaffold();
  const hooks = await loadLegacyHooks(launcher, dir);
  assert.deepEqual(Object.keys(hooks).sort(), ["tool.execute.after", "tool.execute.before"]);
});

test("namespaced: an ask is passed through as effect ask, not degraded", async () => {
  const { dir, launcher, payloadLog } = scaffold();
  const hooks = await loadNamespacedHooks(launcher, dir);
  const event: Record<string, unknown> = {
    sessionID: "ses_1",
    action: "bash.run",
    resources: ["rm -rf /"],
    effect: "allow",
  };
  await withDecision(
    JSON.stringify({ kind: "ask", reason: "confirm the delete", rule: "shell-guard" }),
    async () => {
      await hooks["permission.evaluate"]?.(event);
    },
  );
  assert.equal(event.effect, "ask");
  assert.equal(event.message, "confirm the delete");

  const sent = JSON.parse(readFileSync(payloadLog, "utf8")) as Record<string, unknown>;
  assert.equal(sent.pluginApi, "namespaced");
  assert.equal(sent.hook, "permission.evaluate");
  assert.deepEqual(sent.resources, ["rm -rf /"]);
});

test("namespaced: a deny at the permission hook sets deny, and anything else leaves the host's own effect", async () => {
  const { dir, launcher } = scaffold();
  const hooks = await loadNamespacedHooks(launcher, dir);
  const denied: Record<string, unknown> = { sessionID: "ses_1", action: "bash.run", effect: "allow" };
  await withDecision(JSON.stringify({ kind: "deny", reason: "blocked", rule: "r" }), async () => {
    await hooks["permission.evaluate"]?.(denied);
  });
  assert.equal(denied.effect, "deny");

  const untouched: Record<string, unknown> = { sessionID: "ses_1", action: "bash.run", effect: "ask" };
  await withDecision(JSON.stringify({ kind: "allow" }), async () => {
    await hooks["permission.evaluate"]?.(untouched);
  });
  assert.equal(untouched.effect, "ask", "an allow never downgrades the host's own escalation");
});

test("namespaced: the shell hook blocks on a deny and carries the command it was given", async () => {
  const { dir, launcher, payloadLog } = scaffold();
  const hooks = await loadNamespacedHooks(launcher, dir);
  await withDecision(JSON.stringify({ kind: "deny", reason: "no", rule: "r" }), async () => {
    await assert.rejects(
      async () =>
        await hooks["shell.create.before"]?.({ sessionID: "ses_1", command: "rm -rf /", cwd: "/repo" }),
      /no/,
    );
  });
  const sent = JSON.parse(readFileSync(payloadLog, "utf8")) as Record<string, unknown>;
  assert.equal(sent.hook, "shell.create.before");
  assert.equal(sent.command, "rm -rf /");
  assert.equal(sent.cwd, "/repo");
});

test("namespaced: context after a completed tool rides event.result, and an errored one is left alone", async () => {
  const { dir, launcher } = scaffold();
  const hooks = await loadNamespacedHooks(launcher, dir);
  const completed: Record<string, unknown> = {
    sessionID: "ses_1",
    tool: "bash",
    status: "completed",
    result: { output: "ok" },
  };
  const errored: Record<string, unknown> = {
    sessionID: "ses_1",
    tool: "bash",
    status: "error",
    result: null,
  };
  await withDecision(JSON.stringify({ kind: "context", text: "mind the gate" }), async () => {
    await hooks["tool.execute.after"]?.(completed);
    await hooks["tool.execute.after"]?.(errored);
  });
  assert.deepEqual(completed.result, { output: "ok", tlcHarness: "mind the gate" });
  assert.equal(errored.result, null);
});

test("namespaced: the bridge registers all four hooks its wiring declares", async () => {
  const { dir, launcher } = scaffold();
  const hooks = await loadNamespacedHooks(launcher, dir);
  assert.deepEqual(Object.keys(hooks).sort(), [
    "permission.evaluate",
    "shell.create.before",
    "tool.execute.after",
    "tool.execute.before",
  ]);
});
