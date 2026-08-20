/**
 * Where a model's price comes from, and how it is read.
 *
 * There is one catalogue file on the machine. It used to be four — a per-provider table, a ~1 MB fallback table,
 * an overrides table and an alias table — three of them versioned in this repository and two of them holding the
 * same models at different prices. That is not duplication to be collapsed: the same model genuinely has two
 * prices depending on who bills the call, and a provider reselling a vendor's model charges its own rate. So the
 * planes stay, and the file does not: one catalogue, one refresh, one read path, with each plane named by its
 * provenance ([/decisions/ad-096.md](/decisions/ad-096.md)).
 *
 * invariant: nothing about prices is versioned. A rate published today has to reach an operator without a release,
 * and a rate in the package is stale the moment it is packed.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runtimeHome } from "./paths.ts";

export type VendorPool = "cursor_models" | "anthropic_models" | "other_models" | "auto" | "unknown";
export type NeutralPool = "provider_native" | "other" | "auto" | "unknown";
export type CostSource = "override" | "provider" | "litellm" | "missing";

export type ModelPriceEntry = {
  displayName?: string;
  provider?: string;
  promptPer1M?: number;
  completionPer1M?: number;
  cacheWritePer1M?: number;
  cacheReadPer1M?: number;
  pool?: VendorPool;
  billing?: "metered" | "included" | "unknown";
  contextWindow?: number;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type CostEstimate = {
  costUsd: number | null;
  billing: "metered" | "included" | "unknown";
  pool: VendorPool;
  source: CostSource;
  catalogKey?: string;
};

export type PriceTable = Record<string, ModelPriceEntry>;

/**
 * The catalogue on disk. `planes` is keyed by provenance: a provider's id for what that provider bills, and
 * `litellm` for the vendors' own list prices.
 *
 * why: keyed rather than merged. `claude-sonnet-4-5` is sold by its vendor and resold by other providers at a
 * different rate; merging the two rows would pick one at random and report the other's calls at the wrong price.
 */
export type PriceCatalogue = {
  _meta?: { refreshedAt?: string; planes?: Record<string, PlaneMeta> };
  planes?: Record<string, PriceTable>;
};

export type PlaneMeta = { source?: string; count?: number; refreshedAt?: string };

/** The plane that holds the vendors' own list prices, used when the asking provider has no rate of its own. */
export const FALLBACK_PLANE = "litellm";

/**
 * Model ids a host reports that are not the catalogue's key for them.
 *
 * why: in code, not in a versioned JSON file. This is a hand-curated mapping of what hosts call things — it changes
 * when a host renames a model, which is a code change with a test, not machine state an operator maintains. The
 * file it replaces held ten entries of which six were `"x": "x"` no-ops and two were already covered by the effort
 * suffix stripped below ([/decisions/ad-096.md](/decisions/ad-096.md)).
 *
 * invariant: an operator who needs a mapping of their own writes the key straight into their overrides file. There
 * is no second alias file to keep in sync.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "cursor-grok-4.5": "grok-4.5",
  auto: "auto-cost",
};

const VENDOR_TO_NEUTRAL_POOL: Record<VendorPool, NeutralPool> = {
  cursor_models: "provider_native",
  anthropic_models: "provider_native",
  other_models: "other",
  auto: "auto",
  unknown: "unknown",
};

export function mapPoolToNeutral(pool: VendorPool): NeutralPool {
  return VENDOR_TO_NEUTRAL_POOL[pool];
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function stripMeta(table: PriceTable | null): PriceTable {
  if (!table) {
    return {};
  }
  const { _meta: _ignored, ...rest } = table as PriceTable & { _meta?: unknown };
  return rest;
}

/**
 * The one way a model name becomes a catalogue key. Both sides use it: the refresh that writes the catalogue and
 * the lookup that reads it.
 *
 * hazard: there were two of these, and they disagreed about parentheses. This one erased them, so a lookup for
 * `Model X (Fast)` asked for `model-x` — the standard model's price. The writer's copy erased them too, so the two
 * rows collapsed onto one key and the second overwrote the first. Measured on the real catalogue: 51 rows on the
 * upstream page became 44 stored keys, and every model with a `(Fast)` variant carried the wrong price — `$3/$15`
 * where the page said `$0.5/$2.5` ([/decisions/ad-096.md](/decisions/ad-096.md)).
 *
 * invariant: a qualifier is part of the identity. A markdown link keeps its text and loses its URL; everything
 * else that is not alphanumeric is a separator. Two names that differ produce two keys.
 */
export function slugifyModelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[[\]]/g, "")
    .replace(/[^a-z0-9.+]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function candidatesFor(model: string, aliases: Readonly<Record<string, string>>): string[] {
  const trimmed = model.trim();
  const out: string[] = [];
  const push = (v: string | undefined) => {
    if (v && !out.includes(v)) {
      out.push(v);
    }
  };
  push(trimmed);
  push(aliases[trimmed]);
  push(slugifyModelName(trimmed));
  push(aliases[slugifyModelName(trimmed)]);
  if (trimmed.includes("/")) {
    push(trimmed.slice(trimmed.lastIndexOf("/") + 1));
  }
  const noEffort = trimmed.replace(/-(high|medium|low|max|fast|thinking)$/i, "");
  if (noEffort !== trimmed) {
    push(noEffort);
    push(aliases[noEffort]);
    push(slugifyModelName(noEffort));
  }
  return out;
}

function fuzzyFind(table: PriceTable, needle: string): { key: string; entry: ModelPriceEntry } | undefined {
  const direct = table[needle];
  if (direct) {
    return { key: needle, entry: direct };
  }
  for (const [key, entry] of Object.entries(table)) {
    if (needle.startsWith(key) || key.startsWith(needle)) {
      return { key, entry };
    }
  }
  return undefined;
}

/** The catalogue the refresh writes. Not versioned, not packaged, per machine. */
export function cataloguePath(): string {
  return join(runtimeHome(), "model-prices.json");
}

/**
 * The operator's own rates, which win over everything fetched.
 *
 * hazard: this filename was in `.gitignore` and read by nothing. The overrides that were actually read lived in
 * `model-prices.json` — the same name the refresh now writes — so an operator's edits sat in a file the next
 * refresh would replace. The refresh moves such a file here rather than overwriting it.
 */
export function overridesPath(): string {
  return join(runtimeHome(), "model-prices.local.json");
}

export type PriceResolution = {
  entry: ModelPriceEntry;
  key: string;
  source: "override" | "provider" | "litellm";
};

type CacheSlot = { mtimeMs: number; size: number; value: PriceCatalogue };
const cache = new Map<string, CacheSlot>();

/**
 * why: the fallback plane is around a megabyte and a cost estimate happens on every tool result. This used to
 * parse every catalogue file on every single lookup. The stat is the cheap part; the parse is not.
 *
 * invariant: keyed on mtime and size, so a refresh during a session is picked up on the next lookup without any
 * invalidation call. Nothing has to remember to clear this.
 */
function readCatalogue<T>(path: string): T | null {
  if (!existsSync(path)) {
    cache.delete(path);
    return null;
  }
  const stat = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.value as T;
  }
  const parsed = readJsonFile<PriceCatalogue>(path);
  if (parsed === null) {
    cache.delete(path);
    return null;
  }
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value: parsed });
  return parsed as T;
}

/** invariant: an absent or unparseable catalogue is an empty one. A missing price is never a thrown error. */
export function loadCatalogue(): PriceCatalogue {
  return readCatalogue<PriceCatalogue>(cataloguePath()) ?? {};
}

export function planeMeta(): Record<string, PlaneMeta> {
  return loadCatalogue()._meta?.planes ?? {};
}

export function catalogueMeta(): { refreshedAt?: string } | null {
  const parsed = readCatalogue<PriceCatalogue>(cataloguePath());
  return parsed === null ? null : (parsed._meta ?? {});
}

function planeFor(catalogue: PriceCatalogue, plane: string): PriceTable {
  return stripMeta(catalogue.planes?.[plane] ?? null);
}

export function resolveModelPrice(provider: string, model: string): PriceResolution | undefined {
  const trimmed = model.trim();
  if (!trimmed) {
    return undefined;
  }

  const catalogue = loadCatalogue();
  const overrides = stripMeta(readCatalogue<PriceTable>(overridesPath()));
  const native = provider ? planeFor(catalogue, provider) : {};
  const litellm = planeFor(catalogue, FALLBACK_PLANE);

  const candidates = candidatesFor(trimmed, MODEL_ALIASES);

  for (const id of candidates) {
    const entry = overrides[id];
    if (entry) {
      return { entry, key: id, source: "override" };
    }
  }
  for (const id of candidates) {
    const entry = native[id];
    if (entry) {
      return { entry, key: id, source: "provider" };
    }
  }
  for (const id of candidates) {
    const entry = litellm[id];
    if (entry) {
      return { entry, key: id, source: "litellm" };
    }
  }

  const slug = slugifyModelName(trimmed);
  const fuzzyOverride = fuzzyFind(overrides, slug);
  if (fuzzyOverride) {
    return { ...fuzzyOverride, source: "override" };
  }
  const fuzzyNative = fuzzyFind(native, slug);
  if (fuzzyNative) {
    return { ...fuzzyNative, source: "provider" };
  }
  const fuzzyLitellm = fuzzyFind(litellm, slug);
  if (fuzzyLitellm) {
    return { ...fuzzyLitellm, source: "litellm" };
  }

  return undefined;
}

export function estimateCostUsd(
  provider: string,
  model: string | undefined,
  usage: TokenUsage,
): CostEstimate {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;

  if (!model || (inputTokens <= 0 && outputTokens <= 0 && cacheReadTokens <= 0 && cacheWriteTokens <= 0)) {
    return { costUsd: null, billing: "unknown", pool: "unknown", source: "missing" };
  }

  const resolved = resolveModelPrice(provider, model);
  if (!resolved) {
    return { costUsd: null, billing: "unknown", pool: "unknown", source: "missing" };
  }

  const { entry, key, source } = resolved;
  const pool = entry.pool ?? "unknown";

  if (entry.billing === "included") {
    return { costUsd: null, billing: "included", pool, source, catalogKey: key };
  }

  if (typeof entry.promptPer1M !== "number" || typeof entry.completionPer1M !== "number") {
    return { costUsd: null, billing: entry.billing ?? "unknown", pool, source, catalogKey: key };
  }

  let costUsd =
    (inputTokens / 1_000_000) * entry.promptPer1M + (outputTokens / 1_000_000) * entry.completionPer1M;

  if (typeof entry.cacheReadPer1M === "number" && cacheReadTokens > 0) {
    costUsd += (cacheReadTokens / 1_000_000) * entry.cacheReadPer1M;
  }
  if (typeof entry.cacheWritePer1M === "number" && cacheWriteTokens > 0) {
    costUsd += (cacheWriteTokens / 1_000_000) * entry.cacheWritePer1M;
  }

  return { costUsd, billing: "metered", pool, source, catalogKey: key };
}
