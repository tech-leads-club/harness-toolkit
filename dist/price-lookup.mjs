import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/platform/cli-output.ts
var JSON_FLAG = "--json";
function takeJsonFlag(args) {
  const rest = [];
  let json = false;
  for (const arg of args) {
    if (arg === JSON_FLAG) {
      json = true;
      continue;
    }
    rest.push(arg);
  }
  return { json, rest };
}
function emitJson(value, write = writeStdout) {
  write(`${JSON.stringify(value)}
`);
}
function writeStdout(text) {
  process.stdout.write(text);
}

// src/platform/pricing.ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { join as join2 } from "node:path";

// src/platform/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function conventionalRuntimeHome() {
  return join(homedir(), ".tlc", "harness");
}
function runtimeHome(env = process.env) {
  return env.TLC_HOME ?? conventionalRuntimeHome();
}

// src/platform/pricing.ts
var FALLBACK_PLANE = "litellm";
var MODEL_ALIASES = {
  "cursor-grok-4.5": "grok-4.5",
  auto: "auto-cost"
};
function readJsonFile(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
function stripMeta(table) {
  if (!table) {
    return {};
  }
  const { _meta: _ignored, ...rest } = table;
  return rest;
}
function slugifyModelName(name) {
  return name.trim().toLowerCase().replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[[\]]/g, "").replace(/[^a-z0-9.+]+/g, "-").replace(/^-+|-+$/g, "");
}
function candidatesFor(model, aliases) {
  const trimmed = model.trim();
  const out = [];
  const push = (v) => {
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
function fuzzyFind(table, needle) {
  const direct = table[needle];
  if (direct) {
    return { key: needle, entry: direct };
  }
  for (const [key, entry] of Object.entries(table)) {
    if (needle.startsWith(key) || key.startsWith(needle)) {
      return { key, entry };
    }
  }
  return;
}
function cataloguePath() {
  return join2(runtimeHome(), "model-prices.json");
}
function overridesPath() {
  return join2(runtimeHome(), "model-prices.local.json");
}
var cache = new Map;
function readCatalogue(path) {
  if (!existsSync(path)) {
    cache.delete(path);
    return null;
  }
  const stat = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.value;
  }
  const parsed = readJsonFile(path);
  if (parsed === null) {
    cache.delete(path);
    return null;
  }
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value: parsed });
  return parsed;
}
function loadCatalogue() {
  return readCatalogue(cataloguePath()) ?? {};
}
function planeFor(catalogue, plane) {
  return stripMeta(catalogue.planes?.[plane] ?? null);
}
function resolveModelPrice(provider, model) {
  const trimmed = model.trim();
  if (!trimmed) {
    return;
  }
  const catalogue = loadCatalogue();
  const overrides = stripMeta(readCatalogue(overridesPath()));
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
  return;
}
function estimateCostUsd(provider, model, usage) {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  if (!model || inputTokens <= 0 && outputTokens <= 0 && cacheReadTokens <= 0 && cacheWriteTokens <= 0) {
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
  let costUsd = inputTokens / 1e6 * entry.promptPer1M + outputTokens / 1e6 * entry.completionPer1M;
  if (typeof entry.cacheReadPer1M === "number" && cacheReadTokens > 0) {
    costUsd += cacheReadTokens / 1e6 * entry.cacheReadPer1M;
  }
  if (typeof entry.cacheWritePer1M === "number" && cacheWriteTokens > 0) {
    costUsd += cacheWriteTokens / 1e6 * entry.cacheWritePer1M;
  }
  return { costUsd, billing: "metered", pool, source, catalogKey: key };
}

// tools/price-lookup.ts
function parsePriceLookupArgs(argv) {
  const model = argv[0];
  if (!model) {
    return null;
  }
  return { model, provider: argv[1] ?? "" };
}
function lookupPrice(args) {
  const resolved = resolveModelPrice(args.provider, args.model);
  const per1M = estimateCostUsd(args.provider, args.model, {
    inputTokens: 1e6,
    outputTokens: 1e6
  });
  return { model: args.model, provider: args.provider, resolved, per1M };
}
function main() {
  const { json, rest } = takeJsonFlag(process.argv.slice(2));
  const args = parsePriceLookupArgs(rest);
  if (!args) {
    console.error("usage: tlc harness prices lookup <model-id> [provider]");
    console.error("   or: node --experimental-strip-types tools/price-lookup.ts <model-id> [provider]  (dev)");
    process.exit(1);
  }
  const result = lookupPrice(args);
  if (json) {
    emitJson(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.resolved) {
    process.exit(2);
  }
}
if (__require.main == __require.module) {
  main();
}
export {
  parsePriceLookupArgs,
  lookupPrice
};
