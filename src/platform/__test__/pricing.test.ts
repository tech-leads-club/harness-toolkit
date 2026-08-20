import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  cataloguePath,
  estimateCostUsd,
  type ModelPriceEntry,
  mapPoolToNeutral,
  overridesPath,
  type PriceTable,
  resolveModelPrice,
  slugifyModelName,
  type VendorPool,
} from "../pricing.ts";

let dir: string;
let previousTlcHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tlc-pricing-test-"));
  previousTlcHome = process.env.TLC_HOME;
  process.env.TLC_HOME = dir;
});

afterEach(() => {
  if (previousTlcHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = previousTlcHome;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The single catalogue, keyed by the plane that bills the call. */
function writeCatalogue(planes: Record<string, PriceTable>, refreshedAt = "2026-08-19T00:00:00.000Z"): void {
  writeFileSync(join(dir, "model-prices.json"), JSON.stringify({ _meta: { refreshedAt }, planes }), "utf8");
}

function writeOverrides(table: PriceTable): void {
  writeFileSync(join(dir, "model-prices.local.json"), JSON.stringify(table), "utf8");
}

test("the catalogue and the overrides are the only two files read", () => {
  assert.equal(cataloguePath(), join(dir, "model-prices.json"));
  assert.equal(overridesPath(), join(dir, "model-prices.local.json"));
});

test("overrides win over the provider's plane and over the fallback", () => {
  writeOverrides({ "model-a": { promptPer1M: 1, completionPer1M: 2, pool: "unknown" } });
  writeCatalogue({
    testprov: { "model-a": { promptPer1M: 100, completionPer1M: 100 } },
    litellm: { "model-a": { promptPer1M: 200, completionPer1M: 200 } },
  });

  const resolved = resolveModelPrice("testprov", "model-a");

  assert.equal(resolved?.source, "override");
  assert.equal(resolved?.entry.promptPer1M, 1);
});

/**
 * why: this is the reason the planes are not merged into one table. The same model is sold by its vendor and
 * resold by a provider at a different rate, so the answer depends on who is billing the call — and a single
 * merged row would report one of the two wrong.
 */
test("AC the same model resolves to a different price per plane, depending on who bills", () => {
  writeCatalogue({
    testprov: { "shared-model": { promptPer1M: 5, completionPer1M: 5, pool: "cursor_models" } },
    litellm: { "shared-model": { promptPer1M: 9, completionPer1M: 9, pool: "unknown" } },
  });

  const viaProvider = resolveModelPrice("testprov", "shared-model");
  const viaVendor = resolveModelPrice("otherprov", "shared-model");

  assert.equal(viaProvider?.source, "provider");
  assert.equal(viaProvider?.entry.promptPer1M, 5);
  assert.equal(viaVendor?.source, "litellm");
  assert.equal(viaVendor?.entry.promptPer1M, 9);
});

test("the fallback plane is used when the asking provider has no plane at all", () => {
  writeCatalogue({ litellm: { "model-c": { promptPer1M: 3, completionPer1M: 3 } } });

  assert.equal(resolveModelPrice("testprov", "model-c")?.source, "litellm");
});

test("an unknown model id yields null cost with cost_source missing", () => {
  const estimate = estimateCostUsd("testprov", "totally-unknown-model", { inputTokens: 10, outputTokens: 5 });

  assert.equal(estimate.costUsd, null);
  assert.equal(estimate.source, "missing");
  assert.equal(estimate.pool, "unknown");
});

/** hazard: a machine that has never refreshed must report no price, not crash a turn. */
test("an absent catalogue returns undefined rather than throwing", () => {
  assert.doesNotThrow(() => resolveModelPrice("testprov", "anything"));
  assert.equal(resolveModelPrice("testprov", "anything"), undefined);
});

test("a corrupt catalogue is treated as absent rather than thrown", () => {
  writeFileSync(join(dir, "model-prices.json"), "{ not json", "utf8");

  assert.doesNotThrow(() => resolveModelPrice("testprov", "anything"));
  assert.equal(resolveModelPrice("testprov", "anything"), undefined);
});

test("a vendor model resolves from the fallback plane with its own pool", () => {
  writeCatalogue({
    litellm: {
      "claude-opus-5": { promptPer1M: 15, completionPer1M: 75, pool: "anthropic_models", billing: "metered" },
    },
  });

  const resolved = resolveModelPrice("claude", "claude-opus-5");

  assert.equal(resolved?.source, "litellm");
  assert.equal(resolved?.entry.pool, "anthropic_models");
  assert.equal(mapPoolToNeutral(resolved?.entry.pool as VendorPool), "provider_native");
});

test("estimateCostUsd computes metered cost from prompt and completion tokens", () => {
  writeCatalogue({
    litellm: { "model-d": { promptPer1M: 2, completionPer1M: 4, pool: "other_models", billing: "metered" } },
  });

  const estimate = estimateCostUsd("testprov", "model-d", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });

  assert.equal(estimate.costUsd, 6);
  assert.equal(estimate.billing, "metered");
});

test("estimateCostUsd adds cache read and cache write costs", () => {
  writeCatalogue({
    litellm: { "model-e": { promptPer1M: 1, completionPer1M: 1, cacheReadPer1M: 0.1, cacheWritePer1M: 0.5 } },
  });

  const estimate = estimateCostUsd("testprov", "model-e", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  });

  assert.equal(estimate.costUsd, 2.6);
});

test("a billing:included entry returns null cost and billing included", () => {
  writeCatalogue({ litellm: { "model-f": { billing: "included" } } });

  const estimate = estimateCostUsd("testprov", "model-f", { inputTokens: 10, outputTokens: 10 });

  assert.equal(estimate.costUsd, null);
  assert.equal(estimate.billing, "included");
});

test("no model and zero usage short-circuits to missing without resolving a catalogue", () => {
  const estimate = estimateCostUsd("testprov", undefined, {});

  assert.equal(estimate.costUsd, null);
  assert.equal(estimate.source, "missing");
});

test("mapPoolToNeutral maps every vendor pool to the correct neutral pool", () => {
  assert.equal(mapPoolToNeutral("cursor_models"), "provider_native");
  assert.equal(mapPoolToNeutral("anthropic_models"), "provider_native");
  assert.equal(mapPoolToNeutral("other_models"), "other");
  assert.equal(mapPoolToNeutral("auto"), "auto");
  assert.equal(mapPoolToNeutral("unknown"), "unknown");
});

test("an empty model string never throws and resolves to undefined", () => {
  assert.doesNotThrow(() => resolveModelPrice("testprov", ""));
  assert.equal(resolveModelPrice("testprov", ""), undefined);
});

/**
 * why: the alias table used to be a versioned JSON file in the repository, most of whose entries were `"x": "x"`.
 * The mapping that is load-bearing — a host prefixing its own name onto a model id — is now in code, where it has
 * a test ([/decisions/ad-096.md](/decisions/ad-096.md)).
 */
test("AC a host-prefixed model id resolves through the alias map in code", () => {
  writeCatalogue({ testprov: { "grok-4.5": { promptPer1M: 1, completionPer1M: 1 } } });

  assert.equal(resolveModelPrice("testprov", "cursor-grok-4.5")?.key, "grok-4.5");
});

test("AC the aggregate cost row resolves through its alias", () => {
  writeCatalogue({ testprov: { "auto-cost": { promptPer1M: 0.9, completionPer1M: 3, pool: "auto" } } });

  assert.equal(resolveModelPrice("testprov", "auto")?.key, "auto-cost");
});

test("an effort suffix falls back to the base model when the variant is not priced separately", () => {
  writeCatalogue({ testprov: { "glm-5.2": { promptPer1M: 1, completionPer1M: 1 } } });

  assert.equal(resolveModelPrice("testprov", "glm-5.2-high")?.key, "glm-5.2");
});

/**
 * hazard: the exact key must win over the suffix-stripping fallback, or a variant with its own rate is billed at
 * its base model's rate — which is the defect the key function carried
 * ([/decisions/ad-096.md](/decisions/ad-096.md)).
 */
test("AC a variant priced separately wins over the base model", () => {
  writeCatalogue({
    testprov: {
      "model-x": { promptPer1M: 0.5, completionPer1M: 2.5 },
      "model-x-fast": { promptPer1M: 3, completionPer1M: 15 },
    },
  });

  assert.equal(resolveModelPrice("testprov", "model-x-fast")?.entry.promptPer1M, 3);
  assert.equal(resolveModelPrice("testprov", "model-x")?.entry.promptPer1M, 0.5);
});

test("a model id with parenthetical noise still resolves via the slug fallback", () => {
  writeCatalogue({ litellm: { "some-model": { promptPer1M: 1, completionPer1M: 1 } } });

  assert.equal(resolveModelPrice("testprov", "Some Model (extra info)")?.key, "some-model");
});

test("slugifyModelName keeps a qualifier and drops a link's URL", () => {
  assert.equal(slugifyModelName("Model X (Fast)"), "model-x-fast");
  assert.equal(slugifyModelName("[Model X](https://example.test/x)"), "model-x");
});

/**
 * hazard: the read path caches the catalogue, because the fallback plane is around a megabyte and a cost estimate
 * runs on every tool result. A cache that does not notice a refresh would serve last week's prices for the rest of
 * the session — invisible, since a price is still returned.
 */
test("AC a refresh during a session is picked up on the next lookup", () => {
  writeCatalogue({ testprov: { "model-g": { promptPer1M: 1, completionPer1M: 1 } } });
  assert.equal(resolveModelPrice("testprov", "model-g")?.entry.promptPer1M, 1);

  const entry: ModelPriceEntry = { promptPer1M: 7, completionPer1M: 7 };
  writeFileSync(
    join(dir, "model-prices.json"),
    JSON.stringify({
      _meta: { refreshedAt: "2026-08-20T00:00:00.000Z" },
      planes: { testprov: { "model-g": entry } },
    }),
    "utf8",
  );

  assert.equal(resolveModelPrice("testprov", "model-g")?.entry.promptPer1M, 7);
});

/** invariant: and a catalogue that is deleted stops answering, rather than the cache outliving the file. */
test("AC a deleted catalogue stops answering from cache", () => {
  writeCatalogue({ testprov: { "model-h": { promptPer1M: 1, completionPer1M: 1 } } });
  assert.ok(resolveModelPrice("testprov", "model-h"));

  rmSync(join(dir, "model-prices.json"));

  assert.equal(resolveModelPrice("testprov", "model-h"), undefined);
});
