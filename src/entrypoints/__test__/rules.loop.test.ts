/**
 * The whole loop, through the real rails, with nothing written by hand.
 *
 * hazard: the first cut of this feature had no producer at all — `observe` was exported and called by nothing, so
 * the store was never written, no proof could exist, and every rule that parsed denied for ever (`require:` is
 * mandatory, so that was every rule). Every test passed, because each one wrote `rule-observations.jsonl` itself.
 * A consumer verified against a hand-written store cannot see a missing producer
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 *
 * invariant: no test in this file touches the store. The only thing allowed to write it is the harness reacting to
 * a host event, which is also the property that keeps the agent from forging a proof.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { projectStateDir } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";
import { stopHandler } from "../stop.ts";
import { subagentStopHandler } from "../subagent-stop.ts";
import { toolAfterHandler } from "../tool-after.ts";
import { toolBeforeHandler } from "../tool-before.ts";

let root: string;

function git(...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlc-rules-loop-"));
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "one");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function withRule(require: string, on = "pr-open"): void {
  mkdirSync(join(root, ".tlc", "harness", "rules"), { recursive: true });
  writeFileSync(
    join(root, ".tlc", "harness", "config.json"),
    JSON.stringify({ version: 1, rules: { enabled: true } }),
    "utf8",
  );
  writeFileSync(
    join(root, ".tlc", "harness", "rules", "review-before-pr.md"),
    `---\non: ${on}\nrequire:\n  - ${require}\notherwise: deny\n---\nConvene the jury.`,
    "utf8",
  );
}

function newCommit(): void {
  git("commit", "-q", "--allow-empty", "-m", "two");
}

const openPr = (): string =>
  JSON.stringify({
    hook_event_name: "beforeShellExecution",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    command: "gh pr create --fill",
    cwd: root,
  });

const juryStopped = (type = "the-jury"): string =>
  JSON.stringify({
    hook_event_name: "subagentStop",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    subagent_type: type,
  });

const commandRan = (command: string): string =>
  JSON.stringify({
    hook_event_name: "afterShellExecution",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    command,
    cwd: root,
  });

const stdinOf = (text: string) => ({ readStdin: () => Promise.resolve(text) });

function observations(): Array<Record<string, unknown>> {
  const path = join(projectStateDir(root), "rule-observations.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the proof comes from a rail, or it does not exist", () => {
  test("AC2/AC3 a review recorded by the real subagent rail is what clears the rule", async () => {
    withRule("subagent(the-jury) since HEAD");

    const blocked = await runHandler(toolBeforeHandler, stdinOf(openPr()));
    assert.equal(blocked.decision.kind, "deny", "nothing has been observed yet");

    await runHandler(subagentStopHandler, stdinOf(juryStopped()));
    assert.equal(observations().length, 1, "the rail wrote it — no test did");
    assert.equal(observations()[0]?.kind, "subagent");

    const cleared = await runHandler(toolBeforeHandler, stdinOf(openPr()));
    assert.notEqual(cleared.decision.kind, "deny");
  });

  /** AC4 — the proof is about the code it was made against, so a later commit needs a later review. */
  test("AC4 one more commit and the same review no longer clears it", async () => {
    withRule("subagent(the-jury) since HEAD");
    await runHandler(subagentStopHandler, stdinOf(juryStopped()));
    assert.notEqual((await runHandler(toolBeforeHandler, stdinOf(openPr()))).decision.kind, "deny");

    newCommit();

    assert.equal((await runHandler(toolBeforeHandler, stdinOf(openPr()))).decision.kind, "deny");
  });

  test("AC5 a different subagent type is not the one the rule asked for", async () => {
    withRule("subagent(the-jury) since HEAD");

    await runHandler(subagentStopHandler, stdinOf(juryStopped("worker")));

    assert.equal(observations().length, 1, "it is still recorded");
    assert.equal((await runHandler(toolBeforeHandler, stdinOf(openPr()))).decision.kind, "deny");
  });

  /**
   * why the after-event and not the before: arriving here is what says the command ran and did not fail. A failure
   * comes as `tool.failure`, which this rail never sees.
   */
  test("AC5 a command proof is written by the real after-shell rail", async () => {
    withRule("command(npm test) since HEAD");

    assert.equal((await runHandler(toolBeforeHandler, stdinOf(openPr()))).decision.kind, "deny");

    await runHandler(toolAfterHandler, stdinOf(commandRan("npm test")));
    assert.deepEqual(
      observations().map((o) => [o.kind, o.value]),
      [["command", "npm test"]],
    );

    assert.notEqual((await runHandler(toolBeforeHandler, stdinOf(openPr()))).decision.kind, "deny");
  });

  /**
   * invariant: the sha travels with the observation. Without it `since HEAD` has nothing to compare and every
   * proof would be eternal.
   */
  test("an observation carries the HEAD it was made against", async () => {
    withRule("subagent(the-jury) since HEAD");
    const head = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();

    await runHandler(subagentStopHandler, stdinOf(juryStopped()));

    assert.equal(observations()[0]?.sha, head);
  });
});

describe("nothing is paid for by an operator who declared nothing", () => {
  test("AC1 with the capability off no rail records anything", async () => {
    mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
    writeFileSync(
      join(root, ".tlc", "harness", "config.json"),
      JSON.stringify({ version: 1, rules: { enabled: false } }),
      "utf8",
    );

    await runHandler(subagentStopHandler, stdinOf(juryStopped()));
    await runHandler(toolAfterHandler, stdinOf(commandRan("npm test")));

    assert.deepEqual(observations(), []);
  });

  /**
   * why this matters beyond tidiness: the observing rails run on every tool call and the sha is a process spawn.
   * A kind no rule asks for is a write and a spawn for a fact nothing will ever read.
   */
  test("a kind no rule requires is not recorded, so no command pays for git", async () => {
    withRule("subagent(the-jury) since HEAD");

    await runHandler(toolAfterHandler, stdinOf(commandRan("npm test")));

    assert.deepEqual(observations(), [], "no rule wants a command proof here");
  });
});

/**
 * The one proof the harness decides rather than witnesses. It is recorded at the single point every gate already
 * funnels through, for the same reason the outcome counter is: a gate added later cannot be forgotten.
 */
describe("a gate proof comes from a gate that ran", () => {
  function withGateRule(exitCode: number): void {
    mkdirSync(join(root, ".tlc", "harness", "rules"), { recursive: true });
    writeFileSync(
      join(root, ".tlc", "harness", "config.json"),
      JSON.stringify({
        version: 1,
        rules: { enabled: true },
        grind: {
          enabled: true,
          lintCommand: [process.execPath, "-e", `process.exit(${exitCode})`],
          maxLoops: 3,
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, ".tlc", "harness", "rules", "lint-before-pr.md"),
      "---\non: pr-open\nrequire:\n  - gate(lint) since HEAD\notherwise: deny\n---\nRun the lint gate first.",
      "utf8",
    );
    // why this shape: the grind trigger reads what the turn changed under `codePaths`, not the state of the tree,
    // so a file written anywhere else runs no gate at all and the assertion would be about nothing.
    writeFileSync(join(root, ".gitignore"), ".tlc/\n", "utf8");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n", "utf8");
    git("add", ".");
    git("commit", "-q", "-m", "code");
    writeFileSync(join(root, "src", "app.ts"), "export const a = 2;\n", "utf8");
  }

  const stopped = (): string =>
    JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "sess-1", status: "completed" });

  test("AC5 a gate that passed is recorded, and it is what clears the rule", async () => {
    withGateRule(0);

    assert.equal((await runHandler(toolBeforeHandler, stdinOf(openPr()))).decision.kind, "deny");

    await runHandler(stopHandler, stdinOf(stopped()));

    assert.deepEqual(
      observations().map((o) => [o.kind, o.value]),
      [["gate", "lint"]],
    );
    assert.notEqual((await runHandler(toolBeforeHandler, stdinOf(openPr()))).decision.kind, "deny");
  });

  /**
   * invariant: only a gate that passed. Recording a failure would let "the gate ran" satisfy a rule that asked for
   * "the gate passed", which is the whole reason for asking.
   */
  test("AC5 a gate that failed is not a proof", async () => {
    withGateRule(1);

    await runHandler(stopHandler, stdinOf(stopped()));

    assert.deepEqual(observations(), []);
    assert.equal((await runHandler(toolBeforeHandler, stdinOf(openPr()))).decision.kind, "deny");
  });
});

/**
 * The other moment. A stop can only be allowed or continued, so the four verdicts land differently here than at an
 * action — and this is the only caller that can see an `on: stop` rule at all.
 *
 * hazard: `on: stop`, `follow-up` and `warn` were declared, parsed and evaluated, and consumed by nothing.
 * `firingRules` handled a stop event that nothing ever passed it, and the action rail read only `.outcomes.length`.
 * Three members of a closed vocabulary that a rule could name and `doctor` would list as active
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
describe("a rule at the end of the turn", () => {
  function withStopRule(otherwise: string, mode = "solo"): void {
    mkdirSync(join(root, ".tlc", "harness", "rules"), { recursive: true });
    writeFileSync(
      join(root, ".tlc", "harness", "config.json"),
      JSON.stringify({ version: 1, mode, rules: { enabled: true } }),
      "utf8",
    );
    writeFileSync(
      join(root, ".tlc", "harness", "rules", "spec-first.md"),
      `---\non: stop\nrequire:\n  - subagent(tlc-spec-driven) since HEAD\notherwise: ${otherwise}\n---\nRun the spec pass before finishing.`,
      "utf8",
    );
  }

  const stopped = (): string =>
    JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: "sess-1", status: "completed" });

  const atStop = async () => (await runHandler(stopHandler, stdinOf(stopped()))).decision;

  test("AC7 deny refuses the stop and carries the operator's text", async () => {
    withStopRule("deny");

    const decision = await atStop();

    assert.equal(decision.kind, "continue");
    assert.match(String(decision.text), /^BLOCKED: rule spec-first \(project\)/);
    assert.match(String(decision.text), /Run the spec pass before finishing\./);
  });

  test("AC7 follow-up refuses the stop too, framed as what is needed", async () => {
    withStopRule("follow-up");

    const decision = await atStop();

    assert.equal(decision.kind, "continue");
    assert.match(String(decision.text), /^NEED: rule spec-first/);
  });

  /** AC8 — the one verdict that is a record rather than a bar. */
  test("AC8 warn says so and lets the turn end", async () => {
    withStopRule("warn");

    const decision = await atStop();

    assert.equal(decision.kind, "context");
    assert.match(String(decision.text), /^ADVISORY: rule spec-first/);
  });

  /**
   * why `ask` refuses here: no host offers an ask channel on a stop, and a verdict that quietly became "allow" at
   * the one moment its channel is missing would be a bar that vanishes.
   *
   * hazard: the first version of this test ran at the default posture, where `effectiveVerdict` has already
   * hardened `ask` into `deny` — so the `ask` branch was unreachable and the test asserted nothing about it.
   * Measured: making that branch pass the stop left the test green. `paired` is the one posture where the verdict
   * survives as itself ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  test("AC13 ask has no channel at a stop, so it refuses rather than passing", async () => {
    withStopRule("ask", "paired");

    assert.equal((await atStop()).kind, "continue");
  });

  test("AC13 and at solo the same rule has already hardened to deny", async () => {
    withStopRule("ask", "solo");

    const decision = await atStop();

    assert.equal(decision.kind, "continue");
    assert.match(decision.kind === "continue" ? decision.text : "", /^BLOCKED:/);
  });

  test("AC3 the same rule stops firing once the real rail has recorded the proof", async () => {
    withStopRule("deny");
    assert.equal((await atStop()).kind, "continue");

    await runHandler(
      subagentStopHandler,
      stdinOf(
        JSON.stringify({
          hook_event_name: "subagentStop",
          workspace_roots: [root],
          conversation_id: "conv-1",
          session_id: "sess-1",
          subagent_type: "tlc-spec-driven",
        }),
      ),
    );

    assert.equal((await atStop()).kind, "abstain");
  });

  test("AC1 an action-time rule is not consulted at the stop", async () => {
    withRule("subagent(the-jury) since HEAD");

    assert.equal((await atStop()).kind, "abstain");
  });
});
