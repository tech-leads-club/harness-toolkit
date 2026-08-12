import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cursorWiring,
  cursorWiringProblems,
  formatWiringProblems,
  unwireCursorHooks,
} from "../cursor.wiring.ts";

const RUNTIME = { launcherPath: "/opt/tlc/bin/tlc-exec.mjs" };

test("target is ~/.cursor/hooks.json with the replace strategy", () => {
  const wiring = cursorWiring(RUNTIME);
  assert.equal(wiring.target, join(homedir(), ".cursor", "hooks.json"));
  assert.equal(wiring.strategy, "replace");
});

test("every hook event the predecessor wired is still covered", () => {
  const wiring = cursorWiring(RUNTIME);
  const hookKeys = new Set(wiring.entries.map((entry) => entry.hookEvent));
  assert.deepEqual(
    [...hookKeys].sort(),
    [
      "afterAgentResponse",
      "afterAgentThought",
      "afterFileEdit",
      "afterMCPExecution",
      "afterShellExecution",
      "beforeMCPExecution",
      "beforeReadFile",
      "beforeShellExecution",
      "beforeSubmitPrompt",
      "postToolUse",
      "postToolUseFailure",
      "preCompact",
      "preToolUse",
      "sessionEnd",
      "sessionStart",
      "stop",
      "subagentStart",
      "subagentStop",
    ].sort(),
  );
  assert.equal(wiring.entries.length, 18);
});

test("sessionStart keeps its 10-second timeout and carries no failClosed", () => {
  const wiring = cursorWiring(RUNTIME);
  const entry = wiring.entries.find((e) => e.hookEvent === "sessionStart");
  assert.equal(entry?.handler, "session-start");
  assert.equal(entry?.timeoutSeconds, 10);
  assert.equal(entry?.failClosed, undefined);
});

test("preToolUse and beforeShellExecution keep failClosed: true", () => {
  const wiring = cursorWiring(RUNTIME);
  const preToolUse = wiring.entries.find((e) => e.hookEvent === "preToolUse");
  const beforeShell = wiring.entries.find((e) => e.hookEvent === "beforeShellExecution");
  assert.equal(preToolUse?.failClosed, true);
  assert.equal(beforeShell?.failClosed, true);
});

test("stop keeps the 120-second timeout and loop_limit of 5", () => {
  const wiring = cursorWiring(RUNTIME);
  const stop = wiring.entries.find((e) => e.hookEvent === "stop");
  assert.equal(stop?.handler, "stop");
  assert.equal(stop?.timeoutSeconds, 120);
  assert.equal(stop?.loopLimit, 5);
});

test("every handler names a real entrypoint file", () => {
  const wiring = cursorWiring(RUNTIME);
  const entrypoints = new Set(
    readdirSync(join(fileURLToPath(new URL("../../../entrypoints/", import.meta.url))))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, "")),
  );
  for (const entry of wiring.entries) {
    assert.ok(entrypoints.has(entry.handler), `no entrypoint for handler "${entry.handler}"`);
  }
});

test("afterFileEdit and afterAgentResponse keep their matchers", () => {
  const wiring = cursorWiring(RUNTIME);
  const afterFileEdit = wiring.entries.find((e) => e.hookEvent === "afterFileEdit");
  const afterAgentResponse = wiring.entries.find((e) => e.hookEvent === "afterAgentResponse");
  assert.equal(afterFileEdit?.matcher, "Write");
  assert.equal(afterAgentResponse?.matcher, "AgentResponse");
});

test("commands point at the launcher path — node on non-Windows, cmd /c on Windows", () => {
  const posix = cursorWiring(HEALTH_RUNTIME).entries[0];
  assert.equal(posix?.command, process.platform === "win32" ? "cmd" : "node");

  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const win = cursorWiring(HEALTH_RUNTIME).entries[0];
    assert.equal(win?.command, "cmd");
    assert.deepEqual(win?.args.slice(0, 2), ["/c", "node"]);
    assert.ok(win?.args.includes(RUNTIME.launcherPath));
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

// why: the exact shape from the incident. A `preToolUse` whose command was a bare `node` made Node read the hook
// payload as a program, and `failClosed` turned that crash into a blocked tool
// ([/decisions/ad-032.md](/decisions/ad-032.md)).
const LAUNCHER = "/opt/tlc/bin/tlc-exec.mjs";
const HEALTH_RUNTIME = { launcherPath: LAUNCHER };
const EXISTS = (path: string): boolean => path === LAUNCHER;

function hooksDoc(entries: Record<string, { command: string }[]>): string {
  return JSON.stringify({ version: 1, hooks: entries });
}

function fullyWired(): string {
  const hooks: Record<string, { command: string }[]> = {};
  for (const entry of cursorWiring(HEALTH_RUNTIME).entries) {
    hooks[entry.hookEvent] = [{ command: [entry.command, ...entry.args].join(" ") }];
  }
  return hooksDoc(hooks);
}

test("a fully wired file has no problems", () => {
  assert.deepEqual(cursorWiringProblems(fullyWired(), HEALTH_RUNTIME, EXISTS), []);
});

test("a bare executable is reported, naming the event", () => {
  const doc = JSON.parse(fullyWired()) as { hooks: Record<string, { command: string }[]> };
  doc.hooks.preToolUse = [{ command: "node" }];
  const problems = cursorWiringProblems(JSON.stringify(doc), HEALTH_RUNTIME, EXISTS);
  // why: a bare `node` does not name our launcher at all, so it reads as "no harness entry" — which is the correct
  // reading. What matters is that the event is named and the file no longer passes.
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.hookEvent, "preToolUse");
});

test("a command with the script and no handler is reported", () => {
  const doc = JSON.parse(fullyWired()) as { hooks: Record<string, { command: string }[]> };
  doc.hooks.preToolUse = [{ command: `node ${LAUNCHER}` }];
  const problems = cursorWiringProblems(JSON.stringify(doc), HEALTH_RUNTIME, EXISTS);
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.reason ?? "", /no handler after the script/);
});

test("a command with no executable before the script is reported", () => {
  const doc = JSON.parse(fullyWired()) as { hooks: Record<string, { command: string }[]> };
  doc.hooks.preToolUse = [{ command: `${LAUNCHER} tool-before` }];
  const problems = cursorWiringProblems(JSON.stringify(doc), HEALTH_RUNTIME, EXISTS);
  assert.match(problems[0]?.reason ?? "", /no executable before the script/);
});

test("a script that does not exist is reported", () => {
  const problems = cursorWiringProblems(fullyWired(), HEALTH_RUNTIME, () => false);
  assert.ok(problems.length > 0);
  assert.match(problems[0]?.reason ?? "", /does not exist/);
});

test("a declared event with no entry at all is reported as missing", () => {
  const doc = JSON.parse(fullyWired()) as { hooks: Record<string, unknown> };
  delete doc.hooks.preToolUse;
  const problems = cursorWiringProblems(JSON.stringify(doc), HEALTH_RUNTIME, EXISTS);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.hookEvent, "preToolUse");
  assert.match(problems[0]?.reason ?? "", /no harness entry/);
});

// invariant: a hook belonging to another tool is not ours to judge. Flagging it would train an operator to ignore
// the check, which is how a real warning gets missed.
test("another tool's hook in the same file is never reported", () => {
  const doc = JSON.parse(fullyWired()) as { hooks: Record<string, { command: string }[]> };
  doc.hooks.preToolUse = [...(doc.hooks.preToolUse ?? []), { command: "some-other-tool --hook preToolUse" }];
  assert.deepEqual(cursorWiringProblems(JSON.stringify(doc), HEALTH_RUNTIME, EXISTS), []);
});

test("an absent or unparseable file is reported rather than throwing", () => {
  assert.match(cursorWiringProblems(null, HEALTH_RUNTIME, EXISTS)[0]?.reason ?? "", /no hooks file/);
  assert.match(cursorWiringProblems("{ not json", HEALTH_RUNTIME, EXISTS)[0]?.reason ?? "", /not valid JSON/);
});

test("a file with no hooks key reports every declared event as missing", () => {
  const problems = cursorWiringProblems(JSON.stringify({ version: 1 }), HEALTH_RUNTIME, EXISTS);
  assert.equal(problems.length, cursorWiring(HEALTH_RUNTIME).entries.length);
});

test("a quoted launcher path still matches, so a path with spaces is not a false problem", () => {
  const spaced = "/opt/my tlc/bin/tlc-exec.mjs";
  const runtime = { launcherPath: spaced };
  const doc = hooksDoc(
    Object.fromEntries(
      cursorWiring(runtime).entries.map((entry) => [
        entry.hookEvent,
        [{ command: `node "${spaced}" ${entry.handler}` }],
      ]),
    ),
  );
  assert.deepEqual(
    cursorWiringProblems(doc, runtime, (p) => p === spaced),
    [],
  );
});

// why: a fresh install with no wiring produces one problem per declared event, and a doctor line listing all of
// them is a wall.
test("the formatted problems are bounded and say how many were left out", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ hookEvent: `e${i}`, reason: "broken" }));
  const text = formatWiringProblems(many);
  assert.match(text, /and 6 more/);
  assert.equal(text.split(";").length, 4);
});

test("unwire reports the file can go when every entry named our launcher", () => {
  const document = {
    version: 1,
    hooks: {
      stop: [{ command: "node /opt/tlc/bin/tlc-exec.mjs stop", timeout: 120 }],
      preToolUse: [{ command: "node /opt/tlc/bin/tlc-exec.mjs tool-before", timeout: 5 }],
    },
  };
  const result = unwireCursorHooks(JSON.stringify(document));
  assert.equal(result.kind, "empty");
  assert.equal(result.kind === "empty" && result.removed, 2);
});

test("unwire keeps a foreign entry and rewrites the file around it", () => {
  const document = {
    version: 1,
    hooks: {
      stop: [
        { command: "node /opt/tlc/bin/tlc-exec.mjs stop", timeout: 120 },
        { command: "bash /home/me/notify.sh", timeout: 5 },
      ],
    },
  };
  const result = unwireCursorHooks(JSON.stringify(document));
  assert.equal(result.kind, "rewritten");
  const rewritten = JSON.parse(result.kind === "rewritten" ? result.text : "{}");
  assert.equal(result.kind === "rewritten" && result.removed, 1);
  assert.equal(rewritten.version, 1);
  assert.deepEqual(rewritten.hooks.stop, [{ command: "bash /home/me/notify.sh", timeout: 5 }]);
});

test("unwire drops a hook event left with no entries", () => {
  const document = {
    version: 1,
    hooks: {
      stop: [{ command: "node /opt/tlc/bin/tlc-exec.mjs stop" }],
      preToolUse: [{ command: "bash /home/me/guard.sh" }],
    },
  };
  const result = unwireCursorHooks(JSON.stringify(document));
  const rewritten = JSON.parse(result.kind === "rewritten" ? result.text : "{}");
  assert.equal("stop" in rewritten.hooks, false);
  assert.equal("preToolUse" in rewritten.hooks, true);
});

test("unwire says absent for no file and unparsed for a broken one", () => {
  assert.equal(unwireCursorHooks(null).kind, "absent");
  assert.equal(unwireCursorHooks("   ").kind, "absent");
  assert.equal(unwireCursorHooks("{ not json").kind, "unparsed");
  assert.equal(unwireCursorHooks("[]").kind, "unparsed");
});

test("unwire is idempotent — a file with no harness entry is reported empty with nothing removed", () => {
  const result = unwireCursorHooks(JSON.stringify({ version: 1, hooks: {} }));
  assert.equal(result.kind, "empty");
  assert.equal(result.kind === "empty" && result.removed, 0);
});
