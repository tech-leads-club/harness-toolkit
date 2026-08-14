import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityCatalog, CatalogCapability } from "../../src/core/capability/capability.types.ts";
import { FLOOR_RULE_IDS, FLOOR_RULES } from "../../src/core/floor/floor.catalog.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type RenderTarget = { file: string; marker: string; render: (catalog: CapabilityCatalog) => string };

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function keys(capability: CatalogCapability): string {
  return `\`${capability.configPath}\``;
}

function asks(capability: CatalogCapability): string {
  const list = capability.asks ?? [];
  if (list.length === 0) {
    return capability.recommend ? `recommend **${capability.recommend}**` : "—";
  }
  const rendered = list.map((ask) => `\`${ask}\``).join(", ");
  return capability.recommend ? `${rendered}; recommend **${capability.recommend}**` : rendered;
}

export function renderSkillTable(catalog: CapabilityCatalog): string {
  const rows = catalog.capabilities.map((capability, index) =>
    [
      String(index + 1),
      cell(capability.title),
      keys(capability),
      capability.defaultOn ? "**on**" : "off",
      cell(capability.benefit),
      cell(capability.tradeOff),
      cell(asks(capability)),
    ].join(" | "),
  );
  return [
    "| # | Capability | Key | Default | Benefit | Trade-off | Extra asks if yes |",
    "|---|------------|-----|---------|---------|-----------|-------------------|",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

/**
 * why: the question the README could not answer was "what does it check, and how do I see it happen?" — asked by
 * someone reverse-engineering the rails one at a time. Each row now carries the event, the verdict and the command
 * that shows the record, and it is generated, so a rail added to the catalog appears here without anyone
 * remembering to add it.
 */
export function renderValidatesTable(catalog: CapabilityCatalog): string {
  const rows = catalog.capabilities.map((capability) =>
    [
      `**${cell(capability.title)}**<br>\`${capability.configPath}\` · ${capability.defaultOn ? "**on**" : "off"}`,
      cell(capability.summary),
      capability.fires.map((kind) => `\`${kind}\``).join("<br>"),
      `\`${capability.verdict}\``,
      cell(capability.inspect),
    ].join(" | "),
  );
  return [
    "| Rail · key · default | What it checks | Fires on | Verdict | How to see it |",
    "|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

export function renderFloorTable(): string {
  const rows = FLOOR_RULE_IDS.map((id) => {
    const doc = FLOOR_RULES[id];
    return [`\`${id}\``, cell(doc.denies), doc.allows === undefined ? "—" : cell(doc.allows)].join(" | ");
  });
  return ["| Rule | Denies | Allowed anyway |", "|---|---|---|", ...rows.map((row) => `| ${row} |`)].join(
    "\n",
  );
}

export function renderRailsTable(catalog: CapabilityCatalog): string {
  const rows = catalog.capabilities.map((capability) =>
    [cell(capability.title), cell(capability.benefit), keys(capability)].join(" | "),
  );
  return [
    "| Rail | Effect | Status |",
    "|------|--------|--------|",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

export const TARGETS: RenderTarget[] = [
  {
    file: join("skills", "harness-init", "references", "capabilities.md"),
    marker: "capabilities",
    render: renderSkillTable,
  },
  { file: join("docs", "architecture.md"), marker: "rails", render: renderRailsTable },
  { file: join("docs", "architecture.md"), marker: "floor", render: renderFloorTable },
  { file: "README.md", marker: "validates", render: renderValidatesTable },
  { file: "README.md", marker: "floor", render: renderFloorTable },
];

// invariant: only the marked region is owned by the generator. Everything else in these files is prose a
// catalog entry cannot express — the floor table, the always-ask section, the lessons subsection.
export function replaceRegion(text: string, marker: string, body: string): string {
  const open = `<!-- generated:${marker} -->`;
  const close = "<!-- /generated -->";
  const start = text.indexOf(open);
  if (start === -1) {
    throw new Error(`missing region marker ${open}`);
  }
  const end = text.indexOf(close, start);
  if (end === -1) {
    throw new Error(`unterminated region ${open}`);
  }
  return `${text.slice(0, start + open.length)}\n\n${body}\n\n${text.slice(end)}`;
}

export function loadCatalogFile(root = repoRoot): CapabilityCatalog {
  return JSON.parse(readFileSync(join(root, "capabilities", "catalog.json"), "utf8")) as CapabilityCatalog;
}

// why: the README carries two generated regions. Rendering per target read the file from disk each time, so the
// second write silently reverted the first — the classic shape of a generator that looks green and drops half its
// output. Grouping by file makes the regions compose.
export function renderAll(root = repoRoot): { file: string; next: string; current: string }[] {
  const catalog = loadCatalogFile(root);
  const files = [...new Set(TARGETS.map((target) => target.file))];
  return files.map((file) => {
    const current = readFileSync(join(root, file), "utf8");
    const next = TARGETS.filter((target) => target.file === file).reduce(
      (text, target) => replaceRegion(text, target.marker, target.render(catalog)),
      current,
    );
    return { file, current, next };
  });
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const results = renderAll();
  const stale = results.filter((result) => result.current !== result.next);

  if (!check) {
    for (const result of stale) {
      writeFileSync(join(repoRoot, result.file), result.next, "utf8");
    }
    console.log(`render-capabilities: ${stale.length} file(s) rewritten`);
    process.exit(0);
  }

  if (stale.length === 0) {
    console.log("render-capabilities: generated regions match the catalog");
    process.exit(0);
  }
  console.error(
    "render-capabilities: generated regions are out of date — run: node tools/render-capabilities.ts",
  );
  for (const result of stale) {
    console.error(`  ${result.file}`);
  }
  process.exit(1);
}
