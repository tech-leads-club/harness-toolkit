import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EMPTY_RECALL,
  findInRecall,
  MIN_COMMAND_CHARS,
  normalise,
  RECALL_BUDGET_CHARS,
  recallMessage,
  remember,
} from "../untrusted.recall.ts";
import { askIfFromUntrusted, rememberUntrustedOutput } from "../untrusted.service.ts";

const PAGE = "Setup guide\n\n  Run:  npm install --legacy-peer-deps && npm run build\n\nThen open the app.";

test("AC3 a command that appears verbatim in remembered content is found, with its source", () => {
  const recall = remember(EMPTY_RECALL, { source: "fetched web — example.com", text: PAGE });
  const match = findInRecall(recall, "npm install --legacy-peer-deps && npm run build");
  assert.notEqual(match, null);
  assert.equal(match?.source, "fetched web — example.com");
});

test("AC4 nothing remembered means nothing to ask about", () => {
  assert.equal(findInRecall(EMPTY_RECALL, "npm install --legacy-peer-deps && npm run build"), null);
});

// invariant: verbatim, not similar. A rail that matched on shared words would ask about every command in every
// turn that read anything.
test("AC5 sharing words with the content is not a match", () => {
  const recall = remember(EMPTY_RECALL, { source: "web", text: PAGE });
  for (const command of [
    "npm install",
    "npm run build && npm install",
    "npm install --legacy-peer-deps && npm run test",
  ]) {
    assert.equal(findInRecall(recall, command), null, command);
  }
});

test("AC8 whitespace and indentation are irrelevant to the match", () => {
  const recall = remember(EMPTY_RECALL, { source: "web", text: PAGE });
  assert.notEqual(findInRecall(recall, "  npm   install --legacy-peer-deps   &&   npm run build  "), null);
  assert.equal(normalise("  a   b \n c "), "a b c");
});

// why: below a dozen characters a "command" is a word, and a word appearing in a page proves nothing.
test("a command too short to be evidence is not a match", () => {
  const recall = remember(EMPTY_RECALL, { source: "web", text: "please run ls now" });
  assert.equal(findInRecall(recall, "ls"), null);
  assert.equal("ls".length < MIN_COMMAND_CHARS, true);
});

test("AC6 the budget holds, and what was dropped is recorded", () => {
  let recall = EMPTY_RECALL;
  const chunk = "x".repeat(20_000);
  for (let index = 0; index < 6; index += 1) {
    recall = remember(recall, { source: `web ${index}`, text: `${chunk} marker${index}` });
  }
  const total = recall.entries.reduce((sum, entry) => sum + entry.text.length, 0);
  assert.equal(total <= RECALL_BUDGET_CHARS, true, `${total} must fit ${RECALL_BUDGET_CHARS}`);
  assert.equal(recall.droppedChars > 0, true, "dropping is recorded rather than silent");
  // invariant: newest wins. The content a turn just read is what a command in that turn most likely came from.
  assert.equal(recall.entries[0]?.source, "web 5");
});

/**
 * hazard: one real `afterShellExecution` record carried 864 KB. Without truncation a single entry larger than the
 * whole budget would be kept in full and blow it, which is the case the budget exists for.
 */
test("a single entry larger than the budget is truncated, not kept whole", () => {
  const recall = remember(EMPTY_RECALL, { source: "web", text: "y".repeat(RECALL_BUDGET_CHARS * 3) });
  assert.equal(recall.entries.length, 1);
  assert.equal(recall.entries[0]?.text.length, RECALL_BUDGET_CHARS);
  assert.equal(recall.droppedChars, RECALL_BUDGET_CHARS * 2);
});

test("empty content is not remembered", () => {
  assert.deepEqual(remember(EMPTY_RECALL, { source: "web", text: "   \n  " }), EMPTY_RECALL);
});

test("the ask names the source and quotes the command back", () => {
  const text = recallMessage({ source: "MCP tool — search" }, "  npm   install left-pad  ");
  assert.equal(text.includes("MCP tool — search"), true);
  assert.equal(text.includes("npm install left-pad"), true);
  assert.equal(text.includes("Approve it only if you would have written it yourself"), true);
});

/**
 * why: the read and the command are two hook invocations in two processes, so the round trip through disk is the
 * behaviour that matters. A value held in memory would be gone before the command it exists to check arrives.
 */
test("AC3 end to end: recorded at tool.after, asked at tool.before", () => {
  const root = mkdtempSync(join(tmpdir(), "tlc-untrusted-"));
  try {
    const config = {
      enabled: true,
      mode: "enforce" as const,
      extraTools: ["WebFetch"],
      extraCommandPatterns: [],
    };
    const recorded = rememberUntrustedOutput({
      root,
      sessionKey: "s1",
      event: "tool.after",
      toolName: "WebFetch",
      toolOutput: PAGE,
      config,
      providerTools: [],
    });
    assert.equal(recorded, true, "the read was recognised and its output remembered");

    const ask = askIfFromUntrusted({
      root,
      sessionKey: "s1",
      command: "npm install --legacy-peer-deps && npm run build",
      config,
    });
    assert.equal(ask.kind, "ask");
    assert.equal(ask.kind === "ask" && ask.rule, "untrusted-command");
    assert.equal(ask.kind === "ask" && ask.reason.includes("fetched web"), true);

    // invariant: a different command in the same session is not asked about.
    assert.equal(
      askIfFromUntrusted({ root, sessionKey: "s1", command: "npm run lint --fix", config }).kind,
      "abstain",
    );

    // invariant: another session sees nothing. The recall is per session, like the framing marker.
    assert.equal(
      askIfFromUntrusted({
        root,
        sessionKey: "s2",
        command: "npm install --legacy-peer-deps && npm run build",
        config,
      }).kind,
      "abstain",
    );

    // AC7: frame mode neither records nor asks.
    const framing = { ...config, mode: "frame" as const };
    assert.equal(
      rememberUntrustedOutput({
        root,
        sessionKey: "s3",
        event: "tool.after",
        toolName: "WebFetch",
        toolOutput: PAGE,
        config: framing,
        providerTools: [],
      }),
      false,
    );
    assert.equal(
      askIfFromUntrusted({
        root,
        sessionKey: "s1",
        command: "npm install --legacy-peer-deps && npm run build",
        config: framing,
      }).kind,
      "abstain",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// AC2: a host that delivers no output contributes nothing, and says so by returning false rather than pretending.
test("an event with no tool output records nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "tlc-untrusted-none-"));
  try {
    const recorded = rememberUntrustedOutput({
      root,
      sessionKey: "s1",
      event: "tool.after",
      toolName: "WebFetch",
      config: { enabled: true, mode: "enforce", extraTools: ["WebFetch"], extraCommandPatterns: [] },
      providerTools: [],
    });
    assert.equal(recorded, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
