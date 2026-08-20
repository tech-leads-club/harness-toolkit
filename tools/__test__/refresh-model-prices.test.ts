import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { resolveModelPrice, slugifyModelName } from "../../src/platform/pricing.ts";
import { applyPlanes, parseCursorDocs, parseLiteLlm } from "../refresh-model-prices.ts";

/**
 * The catalogue parser had no tests, because the file used to fetch at module scope — importing it to test it would
 * have reached the network. Two defects lived there undetected, and both reached the catalogue this repository
 * shipped ([/decisions/ad-096.md](/decisions/ad-096.md)):
 *
 * - the parser stopped at the first markdown table, so 43 models became 3;
 * - the key function erased parentheses, so `X (Fast)` overwrote `X` and every model with a variant was read back
 *   at the wrong price.
 *
 * Neither is a crash. Both produce a catalogue that parses, looks plausible and is wrong — which is why they need
 * assertions rather than review.
 */

/**
 * The shape of the upstream page as measured: three tables separated by prose headings, model names as markdown
 * links, a variant row directly under its base model, and an em-dash where a price does not apply.
 */
const THREE_TABLE_PAGE = `# Models and pricing

Some prose.

## The provider's own models

| Model | Provider | Input | Cache write | Cache read | Output |
| --- | --- | --- | --- | --- | --- |
| [Model X](https://example.test/x) | Provider | $0.5 | $0.62 | $0.05 | $2.5 |
| Model X (Fast) | Provider | $3 | $3.75 | $0.30 | $15 |

More prose between the tables.

## Frontier models

| Model | Provider | Input | Cache write | Cache read | Output |
| --- | --- | --- | --- | --- | --- |
| Model Y | Other Vendor | $2 | $2.5 | $0.2 | $6 |
| Model Y (Fast) | Other Vendor | $4 | $5 | $0.4 | $12 |

Closing prose.

## Everything else

| Model | Provider | Input | Cache write | Cache read | Output |
| --- | --- | --- | --- | --- | --- |
| Model Z | Third Vendor | $1 | — | — | $4 |
| Auto Cost | Provider | $0.9 | — | — | $3 |
`;

describe("parseCursorDocs", () => {
  /**
   * hazard: this is the defect that shipped. The parser `break`s were written when the page carried one table; the
   * page now carries three. The refresh went from 43 models to 3 and reported success, because 3 is not 0 and 0 was
   * the only thing the guard looked at.
   */
  test("AC every table on the page is read, not just the first", () => {
    const parsed = parseCursorDocs(THREE_TABLE_PAGE);

    assert.ok(parsed["model-x"], "first table");
    assert.ok(parsed["model-y"], "second table — the one the old parser never reached");
    assert.ok(parsed["model-z"], "third table");
    assert.equal(Object.keys(parsed).length, 6, Object.keys(parsed).join(", "));
  });

  /**
   * hazard: the other half of the same shipped defect. `Model X` and `Model X (Fast)` slugified to one key, the Fast
   * row came second and won, and every lookup for the standard model got the Fast price — roughly double, silently,
   * for as long as the catalogue existed.
   */
  test("AC a variant is its own key and keeps its own price", () => {
    const parsed = parseCursorDocs(THREE_TABLE_PAGE);

    assert.equal(parsed["model-x"]?.promptPer1M, 0.5);
    assert.equal(parsed["model-x"]?.completionPer1M, 2.5);
    assert.equal(parsed["model-x-fast"]?.promptPer1M, 3);
    assert.equal(parsed["model-x-fast"]?.completionPer1M, 15);
    assert.equal(parsed["model-y"]?.promptPer1M, 2);
    assert.equal(parsed["model-y-fast"]?.promptPer1M, 4);
  });

  /** invariant: rows never collapse. Six model rows on the page are six keys in the catalogue. */
  test("AC no row is lost to a key collision", () => {
    const rows = THREE_TABLE_PAGE.split("\n").filter(
      (line) => line.startsWith("|") && !line.includes("---") && !line.startsWith("| Model |"),
    );

    assert.equal(Object.keys(parseCursorDocs(THREE_TABLE_PAGE)).length, rows.length);
  });

  test("a markdown link becomes the model's name, not part of its key", () => {
    const parsed = parseCursorDocs(THREE_TABLE_PAGE);

    assert.equal(parsed["model-x"]?.displayName, "Model X");
    assert.ok(
      !Object.keys(parsed).some((key) => key.includes("example.test")),
      `a URL leaked into a key: ${Object.keys(parsed).join(", ")}`,
    );
  });

  /** why: an em-dash means the price does not apply. Storing it as 0 would report a paid call as free. */
  test("a price that does not apply is absent rather than zero", () => {
    const entry = parseCursorDocs(THREE_TABLE_PAGE)["model-z"];

    assert.equal(entry?.promptPer1M, 1);
    assert.equal(entry?.cacheWritePer1M, undefined);
    assert.equal(entry?.cacheReadPer1M, undefined);
  });

  test("the pool is inferred, and the aggregate row is not a model pool", () => {
    const parsed = parseCursorDocs(THREE_TABLE_PAGE);

    assert.equal(parsed["auto-cost"]?.pool, "auto");
    assert.equal(parsed["model-z"]?.pool, "other_models");
  });

  /** hazard: an upstream page whose format changed must yield nothing, so the replace guard refuses it. */
  test("a page with no table yields an empty catalogue rather than junk", () => {
    assert.deepEqual(parseCursorDocs("# Pricing\n\nWe now render prices in JavaScript.\n"), {});
  });

  test("the header row is not stored as a model", () => {
    const parsed = parseCursorDocs(THREE_TABLE_PAGE);

    assert.equal(parsed.model, undefined);
    assert.ok(!Object.keys(parsed).some((key) => key.startsWith("---")));
  });
});

describe("parseLiteLlm", () => {
  test("per-token costs become per-million, and the spec row is dropped", () => {
    const parsed = parseLiteLlm({
      sample_spec: { input_cost_per_token: 1, output_cost_per_token: 1 },
      "vendor/model-q": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
        cache_creation_input_token_cost: 0.00000375,
        max_input_tokens: 200_000,
        litellm_provider: "vendor",
      },
    });

    assert.equal(parsed.sample_spec, undefined);
    assert.equal(parsed["vendor/model-q"]?.promptPer1M, 3);
    assert.equal(parsed["vendor/model-q"]?.completionPer1M, 15);
    assert.equal(parsed["vendor/model-q"]?.cacheReadPer1M, 0.3);
    assert.equal(parsed["vendor/model-q"]?.cacheWritePer1M, 3.75);
    assert.equal(parsed["vendor/model-q"]?.contextWindow, 200_000);
  });

  /** why: an entry with no price is not a free model, it is an unknown one. Storing it would report $0. */
  test("an entry with no cost is not stored", () => {
    assert.deepEqual(parseLiteLlm({ "vendor/no-price": { max_input_tokens: 1000 } }), {});
  });

  /** invariant: the slugged alias never overwrites a real id that another entry already claimed. */
  test("a slugged alias is added without displacing an existing id", () => {
    const parsed = parseLiteLlm({
      "vendor/model-r": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
    });

    assert.equal(parsed["vendor-model-r"]?.displayName, "vendor/model-r");
    assert.equal(parsed["vendor/model-r"]?.promptPer1M, 0.000001 * 1_000_000);
  });
});

/**
 * The cross-side invariant, and the reason the two slugifiers are now one function: a catalogue is only correct if
 * the key the refresh writes is the key the lookup asks for. They disagreed about parentheses, so a variant was
 * written under its own key and read back under its base model's — the wrong price, from a catalogue that was right.
 */
describe("the writer and the reader agree on the key", () => {
  let dir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tlc-refresh-test-"));
    previousHome = process.env.TLC_HOME;
    process.env.TLC_HOME = dir;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.TLC_HOME;
    } else {
      process.env.TLC_HOME = previousHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** invariant: the parser's output goes into a plane of the one catalogue, which is what the reader reads. */
  function publish(plane: string, table: Record<string, unknown>): void {
    writeFileSync(
      join(dir, "model-prices.json"),
      JSON.stringify({ _meta: { refreshedAt: "2026-08-19T00:00:00.000Z" }, planes: { [plane]: table } }),
      "utf8",
    );
  }

  test("AC a variant resolves to its own price, not to its base model's", () => {
    publish("testprov", parseCursorDocs(THREE_TABLE_PAGE));

    const base = resolveModelPrice("testprov", "Model X");
    const fast = resolveModelPrice("testprov", "Model X (Fast)");

    assert.equal(base?.key, "model-x");
    assert.equal(base?.entry.promptPer1M, 0.5);
    assert.equal(fast?.key, "model-x-fast");
    assert.equal(fast?.entry.promptPer1M, 3, "the Fast variant must not read as the standard model");
  });

  test("AC the id the host reports resolves to the same entry as the display name", () => {
    publish("testprov", parseCursorDocs(THREE_TABLE_PAGE));

    assert.equal(resolveModelPrice("testprov", "model-x-fast")?.entry.promptPer1M, 3);
    assert.equal(resolveModelPrice("testprov", "model-y")?.entry.completionPer1M, 6);
  });

  /**
   * invariant: every key the parser produces is what the reader's own key function produces for the same name. One
   * function, asserted from both directions — this is what notices if a second copy is ever introduced.
   */
  test("AC every stored key equals the reader's key for the same display name", () => {
    for (const [key, entry] of Object.entries(parseCursorDocs(THREE_TABLE_PAGE))) {
      assert.equal(slugifyModelName(entry.displayName ?? ""), key);
    }
  });
});

const NOW = new Date("2026-08-19T12:00:00.000Z");
const YESTERDAY = "2026-08-18T12:00:00.000Z";

function table(count: number): Record<string, { promptPer1M: number; completionPer1M: number }> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`model-${i}`, { promptPer1M: 1, completionPer1M: 1 }]),
  );
}

describe("applyPlanes", () => {
  test("a first catalogue takes both planes and records where each came from", () => {
    const { catalogue, outcomes } = applyPlanes(
      {},
      [
        { plane: "prov", source: "https://docs.test/prices", table: table(40) },
        { plane: "litellm", source: "https://raw.test/prices.json", table: table(900) },
      ],
      NOW,
    );

    assert.deepEqual(Object.keys(catalogue.planes ?? {}).sort(), ["litellm", "prov"]);
    assert.equal(catalogue._meta?.planes?.prov?.source, "https://docs.test/prices");
    assert.equal(catalogue._meta?.planes?.prov?.count, 40);
    assert.equal(catalogue._meta?.refreshedAt, NOW.toISOString());
    assert.ok(outcomes.every((outcome) => outcome.accepted));
  });

  /**
   * hazard: this is the shape of the incident. One upstream page changed format, the parse collapsed, and the write
   * went ahead. With two planes in one file a naive write would also have destroyed the plane that was fine.
   */
  test("AC a collapsed plane is refused and the other plane still updates", () => {
    const existing = {
      _meta: { refreshedAt: YESTERDAY, planes: { prov: { count: 43 }, litellm: { count: 900 } } },
      planes: { prov: table(43), litellm: table(900) },
    };

    const { catalogue, outcomes } = applyPlanes(
      existing,
      [
        { plane: "prov", source: "https://docs.test/prices", table: table(3) },
        { plane: "litellm", source: "https://raw.test/prices.json", table: table(950) },
      ],
      NOW,
    );

    assert.equal(
      Object.keys(catalogue.planes?.prov ?? {}).length,
      43,
      "the good plane survives the bad fetch",
    );
    assert.equal(Object.keys(catalogue.planes?.litellm ?? {}).length, 950);
    assert.equal(outcomes.find((o) => o.plane === "prov")?.accepted, false);
    assert.match(outcomes.find((o) => o.plane === "prov")?.reason ?? "", /43/);
    assert.equal(outcomes.find((o) => o.plane === "litellm")?.accepted, true);
  });

  /** invariant: a refused plane keeps the date it already had, so it stays visibly stale instead of looking fresh. */
  test("AC a plane that was refused keeps its old date", () => {
    const existing = {
      _meta: { refreshedAt: YESTERDAY, planes: { prov: { count: 43, refreshedAt: YESTERDAY } } },
      planes: { prov: table(43) },
    };

    const { catalogue } = applyPlanes(
      existing,
      [{ plane: "prov", source: "https://docs.test/prices", table: table(1) }],
      NOW,
    );

    assert.equal(catalogue._meta?.planes?.prov?.refreshedAt, YESTERDAY);
    assert.equal(catalogue._meta?.refreshedAt, YESTERDAY, "nothing changed, so the file is not newer");
  });

  test("an empty parse never replaces a plane", () => {
    const existing = { planes: { prov: table(10) } };

    const { catalogue, outcomes } = applyPlanes(
      existing,
      [{ plane: "prov", source: "https://docs.test/prices", table: {} }],
      NOW,
    );

    assert.equal(Object.keys(catalogue.planes?.prov ?? {}).length, 10);
    assert.equal(outcomes[0]?.accepted, false);
  });

  /** why: a plane not being refreshed this run is not a plane being dropped. */
  test("a plane absent from the updates is carried through untouched", () => {
    const existing = {
      _meta: { refreshedAt: YESTERDAY, planes: { litellm: { count: 900, refreshedAt: YESTERDAY } } },
      planes: { litellm: table(900) },
    };

    const { catalogue } = applyPlanes(
      existing,
      [{ plane: "prov", source: "https://docs.test/prices", table: table(40) }],
      NOW,
    );

    assert.equal(Object.keys(catalogue.planes?.litellm ?? {}).length, 900);
    assert.equal(catalogue._meta?.planes?.litellm?.refreshedAt, YESTERDAY);
    assert.equal(catalogue._meta?.refreshedAt, NOW.toISOString());
  });
});
