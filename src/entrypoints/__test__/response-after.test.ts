import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { responseAfterHandler } from "../response-after.ts";
import { runHandler } from "../run.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-response-after-"));
}

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

function cursorResponse(root: string, text: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "afterAgentResponse",
    workspace_roots: [root],
    conversation_id: "conv-1",
    session_id: "sess-1",
    text,
    ...overrides,
  });
}

function claudeResponse(root: string, text: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "MessageDisplay",
    cwd: root,
    session_id: "sess-1",
    text,
    ...overrides,
  });
}

test("a HARNESS_SHIP_CLAIM response records a claim on the handoff", async () => {
  const root = tempRoot();
  try {
    await runHandler(
      responseAfterHandler,
      stdinOf(cursorResponse(root, "HARNESS_SHIP_CLAIM: shipped the fix")),
    );
    const handoff = coreFacade.handoff.readHandoff(root, "cursor", "cursor-conv-1");
    assert.equal(handoff.last_ship_claim_kind, "structured");
    assert.match(String(handoff.last_ship_claim_snippet), /shipped the fix/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("free-English 'done' text does not record a claim", async () => {
  const root = tempRoot();
  try {
    await runHandler(responseAfterHandler, stdinOf(cursorResponse(root, "I'm done, everything works now.")));
    const handoff = coreFacade.handoff.readHandoff(root, "cursor", "cursor-conv-1");
    assert.equal(handoff.last_ship_claim_kind, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty response text does not record a claim", async () => {
  const root = tempRoot();
  try {
    await runHandler(responseAfterHandler, stdinOf(cursorResponse(root, "")));
    const handoff = coreFacade.handoff.readHandoff(root, "cursor", "cursor-conv-1");
    assert.equal(handoff.last_ship_claim_kind, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the claim is written with a parseable timestamp", async () => {
  const root = tempRoot();
  try {
    const now = new Date("2026-07-29T12:00:00.000Z");
    await runHandler(responseAfterHandler, {
      ...stdinOf(cursorResponse(root, "HARNESS_SHIP_CLAIM: done")),
      now: () => now,
    });
    const handoff = coreFacade.handoff.readHandoff(root, "cursor", "cursor-conv-1");
    assert.equal(handoff.last_ship_claim_at, now.toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the claim is written to the active provider's own slice, not the other provider's", async () => {
  const root = tempRoot();
  try {
    await runHandler(responseAfterHandler, stdinOf(cursorResponse(root, "HARNESS_SHIP_CLAIM: done")));
    const cursorSlice = coreFacade.handoff.readHandoff(root, "cursor", "cursor-conv-1");
    const claudeSlice = coreFacade.handoff.readHandoff(root, "claude", "claude-none");
    assert.equal(cursorSlice.last_ship_claim_kind, "structured");
    assert.equal(claudeSlice.last_ship_claim_kind, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claim row is appended to the ship ledger", async () => {
  const root = tempRoot();
  try {
    await runHandler(responseAfterHandler, stdinOf(cursorResponse(root, "HARNESS_SHIP_CLAIM: done")));
    const ledger = coreFacade.ship.readShipLedger(root);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.event, "claim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ledger row records the reporting provider", async () => {
  const root = tempRoot();
  try {
    await runHandler(responseAfterHandler, stdinOf(claudeResponse(root, "HARNESS_SHIP_CLAIM: done")));
    const ledger = coreFacade.ship.readShipLedger(root);
    assert.equal(ledger[0]?.provider, "claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("free-English text does not append a ledger row", async () => {
  const root = tempRoot();
  try {
    await runHandler(responseAfterHandler, stdinOf(cursorResponse(root, "Looks good, all set.")));
    const ledger = coreFacade.ship.readShipLedger(root);
    assert.equal(ledger.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple ship claims accumulate multiple ledger rows", async () => {
  const root = tempRoot();
  try {
    await runHandler(responseAfterHandler, stdinOf(cursorResponse(root, "HARNESS_SHIP_CLAIM: first")));
    await runHandler(responseAfterHandler, stdinOf(cursorResponse(root, "HARNESS_SHIP_CLAIM: second")));
    const ledger = coreFacade.ship.readShipLedger(root);
    assert.equal(ledger.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude renders a ship claim response with no stdout, leaving the displayed text untouched", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(
      responseAfterHandler,
      stdinOf(claudeResponse(root, "HARNESS_SHIP_CLAIM: done")),
    );
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, null);
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor renders a non-claim response as the plain abstain payload", async () => {
  const root = tempRoot();
  try {
    const outcome = await runHandler(responseAfterHandler, stdinOf(cursorResponse(root, "all good")));
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
