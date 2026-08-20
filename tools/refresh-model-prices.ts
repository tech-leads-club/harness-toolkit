#!/usr/bin/env node
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { coreFacade } from "../src/core/index.ts";
import { runtimeHome } from "../src/platform/paths.ts";
import {
  cataloguePath,
  FALLBACK_PLANE,
  loadCatalogue,
  type ModelPriceEntry,
  overridesPath,
  type PriceCatalogue,
  type PriceTable,
  slugifyModelName,
} from "../src/platform/pricing.ts";

/**
 * hazard: this was `dirname(import.meta.url)/..` — the directory the script lives in. Under an npm install that is
 * inside the package, which npm replaces wholesale on the next update, so the refresh wrote prices into a directory
 * that would be deleted while `pricing.ts` read `runtimeHome()` and never received them. The same reason the
 * runtime is materialised outside the package at all ([/decisions/ad-056.md](/decisions/ad-056.md),
 * [/decisions/ad-096.md](/decisions/ad-096.md)).
 *
 * invariant: written where it is read. One resolution, `runtimeHome()`, used by both sides.
 */
const HARNESS_HOME = runtimeHome();

/**
 * The plane a provider's own rates land in. It is the provider's id, because the catalogue is keyed by who bills
 * the call and a second provider publishing its own rates is a new plane, not a new file.
 */
const PROVIDER_PLANE = "cursor";
const PROVIDER_DOCS_URL = "https://cursor.com/docs/models-and-pricing.md";
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json";

/**
 * The files this replaced. Left on disk they are stale duplicates of two planes and an alias table nothing reads,
 * and the operator has no way to tell which one a price came from ([/decisions/ad-096.md](/decisions/ad-096.md)).
 */
const SUPERSEDED = [
  `model-prices.${PROVIDER_PLANE}.json`,
  "model-prices.litellm.json",
  "model-aliases.json",
] as const;

/**
 * hazard: `model-prices.json` used to be the operator's overrides table, and it is the name this now writes. An
 * operator who had put their own rates in it would have had them replaced by the first refresh. A flat table with
 * no `planes` key is that old file, so it is moved to where overrides are read from rather than overwritten.
 */
function adoptLegacyOverrides(quiet: boolean): void {
  const path = cataloguePath();
  if (!existsSync(path)) {
    return;
  }
  const parsed = loadCatalogue();
  const keys = Object.keys(parsed).filter((key) => key !== "_meta");
  if (parsed.planes !== undefined || keys.length === 0) {
    return;
  }
  if (existsSync(overridesPath())) {
    console.error(
      `refresh: ${basename(path)} holds ${keys.length} legacy entries and ${basename(overridesPath())} already exists — merge them by hand`,
    );
    return;
  }
  renameSync(path, overridesPath());
  if (!quiet) {
    console.log(`refresh: moved ${keys.length} local overrides → ${overridesPath()}`);
  }
}

/** invariant: only the exact names this replaced, only inside the runtime home. Nothing else is removed. */
function retireSupersededFiles(quiet: boolean): void {
  for (const name of SUPERSEDED) {
    const path = join(HARNESS_HOME, name);
    if (!existsSync(path)) {
      continue;
    }
    rmSync(path, { force: true });
    if (!quiet) {
      console.log(`refresh: removed superseded ${name}`);
    }
  }
}

/**
 * invariant: the key a model is written under is computed by the same function the lookup uses. There were two
 * copies of this and they disagreed about parentheses, which is what let a variant overwrite its base model and be
 * read back at the wrong price ([/decisions/ad-096.md](/decisions/ad-096.md)).
 */
const slugify = slugifyModelName;

function parseMoney(cell: string): number | undefined {
  const t = cell.trim();
  if (!t || t === "-" || t === "—" || t.toLowerCase() === "n/a") {
    return undefined;
  }
  const m = t.replace(/,/g, "").match(/\$?\s*([0-9]*\.?[0-9]+)/);
  if (!m) {
    return undefined;
  }
  return Number(m[1]);
}

function stripCell(cell: string): string {
  return cell
    .trim()
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .trim();
}

export function inferPool(displayName: string, provider: string): ModelPriceEntry["pool"] {
  const n = displayName.toLowerCase();
  if (n === "auto cost" || n.startsWith("auto ")) {
    return "auto";
  }
  if (provider.toLowerCase() === "cursor" || n.includes("composer") || n.includes("grok 4.5")) {
    return "cursor_models";
  }
  return "other_models";
}

/**
 * hazard: this used to `break` on the first line that is not a table row, so it read the FIRST table and stopped.
 * The page now carries three: the provider's own models, then the rest. The parser went from 43 models to 3
 * overnight and the only guard was `count === 0`, so a mutilated catalogue overwrote a good one and read as a
 * successful refresh ([/decisions/ad-096.md](/decisions/ad-096.md)).
 *
 * invariant: every table on the page, and the header row of each resets the column expectation rather than ending
 * the parse.
 */
export function parseCursorDocs(md: string): PriceTable {
  const out: PriceTable = {};
  const lines = md.split("\n");
  let inTable = false;

  for (const line of lines) {
    if (!line.startsWith("|")) {
      // why: leaving a table is not the end of the document. The next one may be a few lines down.
      inTable = false;
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 6) {
      continue;
    }
    const [cell0 = "", cell1 = "", cell2 = "", cell3 = "", cell4 = "", cell5 = ""] = cells;
    if (cell0.toLowerCase() === "model" || cell0.startsWith("---") || cell0.includes("---")) {
      inTable = true;
      continue;
    }
    if (!inTable) {
      continue;
    }

    const displayName = stripCell(cell0);
    const provider = stripCell(cell1);
    const promptPer1M = parseMoney(cell2);
    const cacheWritePer1M = parseMoney(cell3);
    const cacheReadPer1M = parseMoney(cell4);
    const completionPer1M = parseMoney(cell5);
    if (!displayName || promptPer1M === undefined || completionPer1M === undefined) {
      continue;
    }

    const key = slugify(displayName);
    out[key] = {
      displayName,
      provider,
      promptPer1M,
      completionPer1M,
      cacheWritePer1M,
      cacheReadPer1M,
      pool: inferPool(displayName, provider),
      billing: "metered",
    };
  }

  return out;
}

type LiteLlmEntry = {
  max_input_tokens?: number;
  max_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
};

export function parseLiteLlm(raw: Record<string, LiteLlmEntry>): PriceTable {
  const out: PriceTable = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (id === "sample_spec") {
      continue;
    }
    const contextWindow =
      typeof entry.max_input_tokens === "number" ? entry.max_input_tokens : entry.max_tokens;
    const compact: ModelPriceEntry = {
      displayName: id,
      provider: entry.litellm_provider,
      pool: "unknown",
      billing: "metered",
    };
    if (typeof contextWindow === "number" && contextWindow > 0) {
      compact.contextWindow = contextWindow;
    }
    if (typeof entry.input_cost_per_token === "number" && typeof entry.output_cost_per_token === "number") {
      compact.promptPer1M = entry.input_cost_per_token * 1_000_000;
      compact.completionPer1M = entry.output_cost_per_token * 1_000_000;
    } else {
      continue;
    }
    if (typeof entry.cache_read_input_token_cost === "number") {
      compact.cacheReadPer1M = entry.cache_read_input_token_cost * 1_000_000;
    }
    if (typeof entry.cache_creation_input_token_cost === "number") {
      compact.cacheWritePer1M = entry.cache_creation_input_token_cost * 1_000_000;
    }
    out[id] = compact;
    const slug = slugify(id);
    if (slug !== id && !out[slug]) {
      out[slug] = { ...compact, displayName: id };
    }
  }
  return out;
}

/**
 * Which planes a refresh may write, and what happens when one of them comes back mutilated.
 *
 * invariant: a plane is replaced only if the incoming table is not a large loss against what is already there, and
 * a refused plane leaves the others alone. One bad fetch must not take a good catalogue down with it
 * ([/decisions/ad-096.md](/decisions/ad-096.md)).
 */
export type PlaneUpdate = { plane: string; source: string; table: PriceTable };
export type PlaneOutcome = { plane: string; accepted: boolean; reason: string; count: number };

function planeCount(catalogue: PriceCatalogue, plane: string): number {
  return Object.keys(catalogue.planes?.[plane] ?? {}).length;
}

export function applyPlanes(
  existing: PriceCatalogue,
  updates: readonly PlaneUpdate[],
  now: Date,
): { catalogue: PriceCatalogue; outcomes: PlaneOutcome[] } {
  const planes: Record<string, PriceTable> = { ...(existing.planes ?? {}) };
  const planeMeta = { ...(existing._meta?.planes ?? {}) };
  const outcomes: PlaneOutcome[] = [];
  let accepted = 0;

  for (const update of updates) {
    const count = Object.keys(update.table).length;
    const verdict = coreFacade.pricing.mayReplace(planeCount(existing, update.plane), count);
    outcomes.push({ plane: update.plane, accepted: verdict.replace, reason: verdict.reason, count });
    if (!verdict.replace) {
      continue;
    }
    planes[update.plane] = update.table;
    planeMeta[update.plane] = { source: update.source, count, refreshedAt: now.toISOString() };
    accepted += 1;
  }

  // invariant: the file's own date moves only when something in it actually changed, so a refused refresh stays
  // visibly stale rather than looking fresh.
  const refreshedAt = accepted > 0 ? now.toISOString() : existing._meta?.refreshedAt;
  return {
    catalogue: { _meta: { ...(refreshedAt ? { refreshedAt } : {}), planes: planeMeta }, planes },
    outcomes,
  };
}

/**
 * hazard: this file used to run its fetches at module scope, so importing it to test the parsers would have hit the
 * network. `parseCursorDocs` and the key function were therefore untested — and both carried a defect that reached
 * the catalogue ([/decisions/ad-096.md](/decisions/ad-096.md)).
 */
async function main(): Promise<void> {
  const mode = (process.argv[2] ?? "all").toLowerCase();
  const ifStale = process.argv.includes("--if-stale");
  const quiet = process.argv.includes("--quiet");

  const path = cataloguePath();

  /**
   * why: `--if-stale` is what makes an automatic refresh safe to wire into `install` and `update`. Without it both
   * would reach the network on every run; with it the common case is one file read.
   *
   * invariant: the freshness decision is the core's and takes the clock as a parameter, and it is per plane —
   * the provider's page changes far more often than the vendor list.
   */
  function wanted(plane: string, label: string): boolean {
    if (!ifStale) {
      return true;
    }
    const meta = existing._meta?.planes?.[plane];
    const state = coreFacade.pricing.freshness(
      existing.planes?.[plane] === undefined ? null : (meta ?? {}),
      new Date(),
    );
    if (coreFacade.pricing.shouldRefetch(state)) {
      return true;
    }
    if (!quiet) {
      console.log(`${coreFacade.pricing.freshnessMessage(state, label)} — not refetching`);
    }
    return false;
  }

  // why: the directory may not exist yet on a first install, and writing into a missing one is the failure this
  // avoids rather than reports.
  mkdirSync(HARNESS_HOME, { recursive: true });
  // invariant: the legacy overrides move out before the catalogue is read, so nothing of the old file's shape —
  // its entries or its date — is carried into the new one.
  adoptLegacyOverrides(quiet);
  const existing = loadCatalogue();

  const updates: PlaneUpdate[] = [];

  if ((mode === "all" || mode === PROVIDER_PLANE) && wanted(PROVIDER_PLANE, `${PROVIDER_PLANE} prices`)) {
    const res = await fetch(PROVIDER_DOCS_URL);
    if (!res.ok) {
      console.error(`refresh: provider docs answered ${res.status} — keeping the catalogue as it is`);
      process.exit(1);
    }
    updates.push({
      plane: PROVIDER_PLANE,
      source: PROVIDER_DOCS_URL,
      table: parseCursorDocs(await res.text()),
    });
  }

  if ((mode === "all" || mode === FALLBACK_PLANE) && wanted(FALLBACK_PLANE, `${FALLBACK_PLANE} prices`)) {
    const res = await fetch(LITELLM_URL);
    if (!res.ok) {
      console.error(`refresh: ${FALLBACK_PLANE} answered ${res.status} — keeping the catalogue as it is`);
      process.exit(1);
    }
    updates.push({
      plane: FALLBACK_PLANE,
      source: LITELLM_URL,
      table: parseLiteLlm((await res.json()) as Record<string, LiteLlmEntry>),
    });
  }

  if (updates.length === 0) {
    return;
  }

  const { catalogue, outcomes } = applyPlanes(existing, updates, new Date());
  const refused = outcomes.filter((outcome) => !outcome.accepted);
  if (outcomes.some((outcome) => outcome.accepted)) {
    writeFileSync(path, `${JSON.stringify(catalogue)}\n`);
    for (const outcome of outcomes.filter((o) => o.accepted)) {
      console.log(`${outcome.plane}: ${outcome.count} models (${outcome.reason}) → ${path}`);
    }
    retireSupersededFiles(quiet);
  }
  for (const outcome of refused) {
    console.error(`${outcome.plane}: ${outcome.reason}`);
  }
  if (refused.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
