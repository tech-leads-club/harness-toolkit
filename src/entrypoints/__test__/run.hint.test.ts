import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectStateDir } from "../../platform/paths.ts";
import { runHandler } from "../run.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-run-hint-"));
}

function obsRecords(root: string): Array<Record<string, unknown>> {
  const path = join(projectStateDir(root), "obs.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stdinOf(value: unknown) {
  return { readStdin: () => Promise.resolve(JSON.stringify(value)) };
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

async function withHint<T>(hint: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = process.env.TLC_PROVIDER_HINT;
  if (hint === undefined) {
    delete process.env.TLC_PROVIDER_HINT;
  } else {
    process.env.TLC_PROVIDER_HINT = hint;
  }
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.TLC_PROVIDER_HINT;
    } else {
      process.env.TLC_PROVIDER_HINT = original;
    }
  }
}

/** A payload every detector agrees belongs to Claude — the control for the two tests below. */
function claudePayload(root: string): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "sess-hint",
    tool_name: "Grep",
  };
}

test("with no hint, a Claude-shaped payload still resolves to Claude", async () => {
  const root = tempRoot();
  try {
    const outcome = await withHint(undefined, () =>
      withCwd(root, () =>
        runHandler(
          (_event, ctx) => ({ kind: "allow", rule: ctx.provider.name }),
          stdinOf(claudePayload(root)),
        ),
      ),
    );
    assert.equal(outcome.event?.provider, "claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The load-bearing case. `cursor` cannot detect this payload — its detector wants `workspace_roots`. Resolving to
 * cursor anyway is the proof that the hint short-circuits detection rather than biasing it, which is what a host
 * emitting another host's shape byte for byte will depend on.
 */
test("a hint overrides content detection entirely", async () => {
  const root = tempRoot();
  try {
    await withHint("cursor", () =>
      withCwd(root, () => runHandler(() => ({ kind: "allow" }), stdinOf(claudePayload(root)))),
    );
    // why the obs record and not the event: cursor cannot parse this payload, so the event is null either way.
    // The record is what names the provider resolution actually picked, which is the claim under test — asserting
    // only "not claude" would also pass if the hint had broken resolution outright.
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    const attrs = records[0]?.attrs as Record<string, unknown>;
    assert.equal(
      attrs.reason,
      "unrecognized-event",
      "resolution reached a provider, then that provider parsed",
    );
    assert.equal(attrs.provider, "cursor", "the hint must beat the detector that claims this payload");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * hazard: falling back to detection on an unmatched hint is the dangerous version of this. The payload below is
 * one Claude's detector claims, so a fallback would resolve it and run — quietly, under a host the wiring never
 * named. The run has to end in abstain instead.
 */
test("an unknown hint abstains and never falls back to detection", async () => {
  const root = tempRoot();
  try {
    const outcome = await withHint("not-a-registered-host", () =>
      withCwd(root, () =>
        runHandler(
          () => ({ kind: "deny", reason: "handler must not run", rule: "hint-guard" }),
          stdinOf(claudePayload(root)),
        ),
      ),
    );
    assert.equal(outcome.event, null);
    assert.equal(outcome.decision.kind, "abstain");
    assert.equal(outcome.rendered.stdout, null);
    assert.equal(outcome.rendered.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown hint is recorded as adapter.unrecognized naming the hint", async () => {
  const root = tempRoot();
  try {
    await withHint("not-a-registered-host", () =>
      withCwd(root, () => runHandler(() => ({ kind: "allow" }), stdinOf(claudePayload(root)))),
    );
    const records = obsRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "adapter.unrecognized");
    const attrs = records[0]?.attrs as Record<string, unknown>;
    assert.equal(attrs.reason, "unknown-provider-hint");
    assert.equal(attrs.hint, "not-a-registered-host");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: an empty variable is what a shell exports for an unset value, and it must read as "no hint" rather than as
// a hint naming nothing — which would refuse every payload on that host.
test("an empty hint is treated as no hint, not as a hint matching nothing", async () => {
  const root = tempRoot();
  try {
    const outcome = await withHint("", () =>
      withCwd(root, () => runHandler(() => ({ kind: "allow" }), stdinOf(claudePayload(root)))),
    );
    assert.equal(outcome.event?.provider, "claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why separately from the empty case: this is what pins the `.trim()`. A whitespace-only value is what a wiring
// line with a stray space exports, and without the trim it is a non-empty hint that names no provider — which
// refuses every payload on that host rather than falling through to detection.
test("a whitespace-only hint is treated as no hint", async () => {
  const root = tempRoot();
  try {
    const outcome = await withHint("   ", () =>
      withCwd(root, () => runHandler(() => ({ kind: "allow" }), stdinOf(claudePayload(root)))),
    );
    assert.equal(outcome.event?.provider, "claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
