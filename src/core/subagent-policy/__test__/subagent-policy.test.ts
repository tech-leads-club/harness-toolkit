import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectStateDir } from "../../../platform/paths.ts";
import {
  candidateModelBlocked,
  isModelAllowlisted,
  modelMatchesBlocked,
  readParentModelState,
  shouldDenyParentFast,
  upsertParentModelState,
} from "../subagent-policy.parent-model.ts";
import { evaluateSubagentSpawn } from "../subagent-policy.service.ts";

const PATTERNS = ["-fast(?:$|[^a-z0-9])", "/fast(?:$|[^a-z0-9])", "provider-a-model-fast"];
const ALLOWED = ["provider-a-model", "provider-a-model-high", "provider-b-model-high"];

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-subagent-policy-"));
}

test("modelMatchesBlocked detects a -fast suffix on a plain slug", () => {
  assert.equal(modelMatchesBlocked("provider-a-model-fast", PATTERNS), "-fast(?:$|[^a-z0-9])");
});

test("modelMatchesBlocked detects a -fast suffix on an effort-qualified slug", () => {
  assert.equal(modelMatchesBlocked("provider-a-model-high-fast", PATTERNS), "-fast(?:$|[^a-z0-9])");
});

test("modelMatchesBlocked detects the bracket form fast=true", () => {
  assert.equal(modelMatchesBlocked("provider-a-model[fast=true]", PATTERNS), "fast=true");
});

test("modelMatchesBlocked allows the bracket form fast=false", () => {
  assert.equal(modelMatchesBlocked("provider-a-model[fast=false]", PATTERNS), null);
});

test("modelMatchesBlocked allows a plain model with no pattern hit", () => {
  assert.equal(modelMatchesBlocked("provider-a-model", PATTERNS), null);
});

test("isModelAllowlisted is true for an exact match", () => {
  assert.equal(isModelAllowlisted("provider-a-model", ALLOWED), true);
});

test("isModelAllowlisted is true when the bracket form is present but fast=false", () => {
  assert.equal(isModelAllowlisted("provider-a-model[fast=false]", ALLOWED), true);
});

test("isModelAllowlisted is false when the bracket form is fast=true", () => {
  assert.equal(isModelAllowlisted("provider-a-model[fast=true]", ALLOWED), false);
});

test("isModelAllowlisted is false for a -fast suffixed slug not on the list", () => {
  assert.equal(isModelAllowlisted("provider-a-model-high-fast", ALLOWED), false);
});

test("candidateModelBlocked detects model_params fast=true", () => {
  assert.equal(
    candidateModelBlocked("provider-a-model", PATTERNS, [{ id: "fast", value: "true" }]),
    "model_params.fast=true",
  );
});

test("candidateModelBlocked allows model_params fast=false", () => {
  assert.equal(candidateModelBlocked("provider-a-model", PATTERNS, [{ id: "fast", value: "false" }]), null);
});

test("candidateModelBlocked is case-insensitive on the fast param", () => {
  assert.equal(
    candidateModelBlocked("provider-a-model", PATTERNS, [{ id: "FAST", value: "TRUE" }]),
    "model_params.fast=true",
  );
});

test("readParentModelState returns null for a session never recorded", () => {
  const root = tempRoot();
  try {
    assert.equal(readParentModelState(root, "missing"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldDenyParentFast is false when no sticky state exists", () => {
  const root = tempRoot();
  try {
    assert.equal(
      shouldDenyParentFast({ enabled: true, projectDir: root, sessionKey: "session-a", patterns: PATTERNS }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upsertParentModelState records fast=true from a -fast slug plus model_params, and readParentModelState round-trips it", () => {
  const root = tempRoot();
  try {
    const snap = upsertParentModelState(
      root,
      "session-a",
      {
        model: "provider-a-model-high-fast",
        model_params: [
          { id: "effort", value: "high" },
          { id: "fast", value: "true" },
        ],
      },
      PATTERNS,
    );
    assert.ok(snap);
    assert.equal(snap?.fast, true);
    assert.equal(readParentModelState(root, "session-a")?.fast, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldDenyParentFast is true once the sticky parent state is fast", () => {
  const root = tempRoot();
  try {
    upsertParentModelState(
      root,
      "session-a",
      { model: "provider-a-model-high-fast", model_params: [{ id: "fast", value: "true" }] },
      PATTERNS,
    );
    assert.equal(
      shouldDenyParentFast({ enabled: true, projectDir: root, sessionKey: "session-a", patterns: PATTERNS }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldDenyParentFast is false when blockParentFast is disabled, even with a fast sticky state", () => {
  const root = tempRoot();
  try {
    upsertParentModelState(
      root,
      "session-a",
      { model: "provider-a-model-high-fast", model_params: [{ id: "fast", value: "true" }] },
      PATTERNS,
    );
    assert.equal(
      shouldDenyParentFast({ enabled: false, projectDir: root, sessionKey: "session-a", patterns: PATTERNS }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upsertParentModelState records fast=false for a non-fast model", () => {
  const root = tempRoot();
  try {
    upsertParentModelState(
      root,
      "session-b",
      { model: "provider-a-model-high", model_params: [{ id: "fast", value: "false" }] },
      PATTERNS,
    );
    assert.equal(
      shouldDenyParentFast({ enabled: true, projectDir: root, sessionKey: "session-b", patterns: PATTERNS }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupted parent-model.json degrades to null/false instead of throwing", () => {
  const root = tempRoot();
  try {
    mkdirSync(projectStateDir(root), { recursive: true });
    writeFileSync(join(projectStateDir(root), "parent-model.json"), "{not-json", "utf8");
    assert.equal(readParentModelState(root, "session-a"), null);
    assert.equal(
      shouldDenyParentFast({ enabled: true, projectDir: root, sessionKey: "session-a", patterns: PATTERNS }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upsertParentModelState returns null for an empty sessionKey", () => {
  const root = tempRoot();
  try {
    assert.equal(upsertParentModelState(root, "", { model: "provider-a-model" }, PATTERNS), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upsertParentModelState returns null when neither model nor model_params is given", () => {
  const root = tempRoot();
  try {
    assert.equal(upsertParentModelState(root, "session-c", {}, PATTERNS), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent-model state is keyed by sessionKey — recording one session leaves another untouched", () => {
  const root = tempRoot();
  try {
    upsertParentModelState(
      root,
      "session-a",
      { model: "provider-a-model-high-fast", model_params: [{ id: "fast", value: "true" }] },
      PATTERNS,
    );
    assert.equal(readParentModelState(root, "session-b"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function baseSpawnArgs(overrides: Partial<Parameters<typeof evaluateSubagentSpawn>[0]> = {}) {
  return {
    provider: "provider-a",
    sessionKey: "session-a",
    projectDir: "",
    model: "provider-a-model",
    allowedModels: ALLOWED,
    blockedPatterns: PATTERNS,
    minEffort: null,
    requireModel: true,
    enforceAllowlist: true,
    blockParentFast: false,
    ...overrides,
  };
}

test("evaluateSubagentSpawn denies a blocked-pattern model", () => {
  const root = tempRoot();
  try {
    const decision = evaluateSubagentSpawn(
      baseSpawnArgs({ model: "provider-a-model[fast=true]", projectDir: root }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") {
      assert.match(decision.reason, /fast=true/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateSubagentSpawn denies a spawn when the parent conversation is sticky fast", () => {
  const root = tempRoot();
  try {
    upsertParentModelState(
      root,
      "session-a",
      { model: "provider-a-model-high-fast", model_params: [{ id: "fast", value: "true" }] },
      PATTERNS,
    );
    const decision = evaluateSubagentSpawn(
      baseSpawnArgs({ model: "provider-b-model-high", blockParentFast: true, projectDir: root }),
    );
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") {
      assert.match(decision.userNote ?? "", /parent conversation is in Fast mode/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateSubagentSpawn allows the same spawn when blockParentFast is off", () => {
  const root = tempRoot();
  try {
    upsertParentModelState(
      root,
      "session-a",
      { model: "provider-a-model-high-fast", model_params: [{ id: "fast", value: "true" }] },
      PATTERNS,
    );
    const decision = evaluateSubagentSpawn(
      baseSpawnArgs({ model: "provider-b-model-high", blockParentFast: false, projectDir: root }),
    );
    assert.equal(decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateSubagentSpawn allows when there is no sticky parent state for this session", () => {
  const root = tempRoot();
  try {
    const decision = evaluateSubagentSpawn(
      baseSpawnArgs({
        model: "provider-b-model-high",
        blockParentFast: true,
        sessionKey: "no-such",
        projectDir: root,
      }),
    );
    assert.equal(decision.kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateSubagentSpawn denies a missing model when requireModel is set", () => {
  const decision = evaluateSubagentSpawn(baseSpawnArgs({ model: "" }));
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.match(decision.userNote ?? "", /without an explicit model/);
  }
});

test("evaluateSubagentSpawn denies a model that is not on the allowlist", () => {
  const decision = evaluateSubagentSpawn(baseSpawnArgs({ model: "provider-c-model" }));
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.match(decision.userNote ?? "", /not on the allowlist/);
  }
});

test("a bare-array allowedModels applies to every provider", () => {
  const decisionA = evaluateSubagentSpawn(
    baseSpawnArgs({ provider: "provider-a", model: "provider-a-model" }),
  );
  const decisionB = evaluateSubagentSpawn(
    baseSpawnArgs({ provider: "provider-b", model: "provider-b-model-high" }),
  );
  assert.equal(decisionA.kind, "allow");
  assert.equal(decisionB.kind, "allow");
});

test("a provider-keyed allowedModels applies only to the active provider's entry", () => {
  const scoped = { "provider-a": ["provider-a-model"], "provider-b": ["provider-b-model-high"] };
  const wrongModelOnA = evaluateSubagentSpawn(
    baseSpawnArgs({ provider: "provider-a", model: "provider-b-model-high", allowedModels: scoped }),
  );
  const rightModelOnB = evaluateSubagentSpawn(
    baseSpawnArgs({ provider: "provider-b", model: "provider-b-model-high", allowedModels: scoped }),
  );
  assert.equal(wrongModelOnA.kind, "deny");
  assert.equal(rightModelOnB.kind, "allow");
});

test("an absent provider key in a provider-keyed allowedModels map means no restriction from that rule", () => {
  const scoped = { "provider-a": ["provider-a-model"] };
  const decision = evaluateSubagentSpawn(
    baseSpawnArgs({ provider: "provider-b", model: "anything-goes", allowedModels: scoped }),
  );
  assert.equal(decision.kind, "allow");
});

test("a bare-array blockedPatterns applies to every provider", () => {
  const decisionA = evaluateSubagentSpawn(
    baseSpawnArgs({ provider: "provider-a", model: "provider-a-model-fast" }),
  );
  const decisionB = evaluateSubagentSpawn(
    baseSpawnArgs({ provider: "provider-b", model: "provider-b-model-fast", enforceAllowlist: false }),
  );
  assert.equal(decisionA.kind, "deny");
  assert.equal(decisionB.kind, "deny");
});

test("an absent provider key in a provider-keyed blockedPatterns map means no restriction from that rule", () => {
  const scoped = { "provider-a": ["-fast(?:$|[^a-z0-9])"] };
  const decision = evaluateSubagentSpawn(
    baseSpawnArgs({
      provider: "provider-b",
      model: "provider-b-model-fast",
      blockedPatterns: scoped,
      enforceAllowlist: false,
      requireModel: false,
    }),
  );
  assert.equal(decision.kind, "allow");
});

test("evaluateSubagentSpawn denies below-minimum effort, naming the observed and required levels", () => {
  const decision = evaluateSubagentSpawn(
    baseSpawnArgs({ minEffort: "high", effort: "low", enforceAllowlist: false, requireModel: false }),
  );
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.match(decision.reason, /"low"/);
    assert.match(decision.reason, /"high"/);
  }
});

test("evaluateSubagentSpawn skips minEffort when the provider reports no effort at all", () => {
  const decision = evaluateSubagentSpawn(
    baseSpawnArgs({ minEffort: "high", effort: undefined, enforceAllowlist: false, requireModel: false }),
  );
  assert.equal(decision.kind, "allow");
});

test("evaluateSubagentSpawn skips minEffort on an unrecognized effort value rather than denying", () => {
  const decision = evaluateSubagentSpawn(
    baseSpawnArgs({ minEffort: "high", effort: "turbo", enforceAllowlist: false, requireModel: false }),
  );
  assert.equal(decision.kind, "allow");
});

test("blockMode defaults to deny when unset", () => {
  const decision = evaluateSubagentSpawn(baseSpawnArgs({ model: "provider-a-model-fast" }));
  assert.equal(decision.kind, "deny");
});

test("blockMode ask returns ask instead of deny, keeping the same reason", () => {
  const denied = evaluateSubagentSpawn(baseSpawnArgs({ model: "provider-a-model-fast" }));
  const asked = evaluateSubagentSpawn(baseSpawnArgs({ model: "provider-a-model-fast", blockMode: "ask" }));
  assert.equal(asked.kind, "ask");
  if (denied.kind === "deny" && asked.kind === "ask") {
    assert.equal(asked.reason, denied.reason);
    assert.equal(asked.userNote, denied.userNote);
  }
});

test("blockMode ask applies to every block reason, not just the pattern hit", () => {
  const missing = evaluateSubagentSpawn(baseSpawnArgs({ model: "", requireModel: true, blockMode: "ask" }));
  assert.equal(missing.kind, "ask");
  const belowEffort = evaluateSubagentSpawn(
    baseSpawnArgs({
      minEffort: "high",
      effort: "low",
      enforceAllowlist: false,
      requireModel: false,
      blockMode: "ask",
    }),
  );
  assert.equal(belowEffort.kind, "ask");
});

/**
 * hazard: the reported case. `enforceAllowlist: true` with `allowedModels: []` denied every model, because `[]` is
 * not `null` — and before that, an empty list fell back to a shipped one, so the refusal came from a list nobody in
 * the project had written. A rule that names nothing cannot say what is allowed
 * ([/decisions/ad-053.md](/decisions/ad-053.md)).
 */
test("an empty allowlist enforces nothing rather than denying everything", () => {
  const decision = evaluateSubagentSpawn(
    // why: a suffixed variant of a listed model, which is the shape that was refused — the match is exact or
    // `prefix[`, so a `-thinking-high` tail never lands on a list of bare slugs.
    baseSpawnArgs({ model: "provider-a-model-thinking-high", allowedModels: [], requireModel: false }),
  );
  assert.equal(decision.kind, "allow");
});

test("an absent allowlist enforces nothing", () => {
  const decision = evaluateSubagentSpawn(
    baseSpawnArgs({ model: "anything", allowedModels: undefined, requireModel: false }),
  );
  assert.equal(decision.kind, "allow");
});

// invariant: the control. A populated list still refuses what is not on it, or the rule would be decoration.
test("a populated allowlist still denies a model outside it", () => {
  const decision = evaluateSubagentSpawn(baseSpawnArgs({ model: "some-other-model" }));
  assert.equal(decision.kind, "deny");
});

/**
 * hazard: the refusal was `Use one of: <list>` and named no source, so an operator reading `"allowedModels": []` in
 * their own config concluded that empty means none — and offered to switch the rail off.
 */
test("the refusal names the key that holds the list", () => {
  const decision = evaluateSubagentSpawn(baseSpawnArgs({ model: "some-other-model" }));
  assert.match(decision.kind === "deny" ? decision.reason : "", /subagents\.allowedModels/);
  assert.match(decision.kind === "deny" ? decision.reason : "", /provider-a-model/);
});

/**
 * hazard: `inherit` means the parent's model, not a model name, and the only occurrences of it in this repository
 * were `stdio: "inherit"`. Answering it with a list of slugs answers a question it did not ask.
 */
test("a refused inherit says inherit is a value the list may contain", () => {
  const decision = evaluateSubagentSpawn(baseSpawnArgs({ model: "inherit" }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.kind === "deny" ? decision.reason : "", /`inherit` is a value that list may contain/);
});

// invariant: the control. An operator who lists `inherit` gets it, which is the whole point of the list being theirs.
test("inherit passes when the operator put it on the list", () => {
  const decision = evaluateSubagentSpawn(baseSpawnArgs({ model: "inherit", allowedModels: ["inherit"] }));
  assert.equal(decision.kind, "allow");
});
