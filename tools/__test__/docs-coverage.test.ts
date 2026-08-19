import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function normalize(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function steeringSection(): string {
  const doc = readFileSync(join(repoRoot, "docs", "architecture.md"), "utf8");
  const start = doc.indexOf("## Steering pillars");
  assert.ok(start !== -1, "architecture.md has no steering pillars section");
  const end = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

// hazard: the floor is the part an operator cannot turn off, so omitting a rule from the docs turns its
// first denial into a mystery.
test("every floor rule appears in the steering pillars section", () => {
  const service = readFileSync(join(repoRoot, "src", "core", "floor", "floor.service.ts"), "utf8");
  const declared = service.slice(
    service.indexOf("export type FloorRule"),
    service.indexOf(";", service.indexOf("export type FloorRule")),
  );
  const rules = [...declared.matchAll(/"([a-z-]+)"/g)].map((match) => match[1] as string);
  assert.ok(rules.length >= 5, `expected the FloorRule union, parsed ${rules.length}`);

  const section = normalize(steeringSection());
  const missing = rules.filter((rule) => !section.includes(normalize(rule)));
  assert.deepEqual(missing, []);
});

// hazard: the floor is what a reader must know before the first denial, so the entry document has to
// carry it. It was absent from the README while being the most distinctive behaviour in the product.
test("the README names every floor rule", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const service = readFileSync(join(repoRoot, "src", "core", "floor", "floor.service.ts"), "utf8");
  const start = service.indexOf("export type FloorRule");
  const declared = service.slice(start, service.indexOf(";", start));
  const rules = [...declared.matchAll(/"([a-z-]+)"/g)].map((match) => match[1] as string);
  const missing = rules.filter((rule) => !readme.includes(rule));
  assert.deepEqual(missing, []);
});

test("the generator owns only its region, and detects a change inside it", async () => {
  const { renderAll, replaceRegion, TARGETS } = await import("../dev/render-capabilities.ts");
  const results = renderAll();
  // why: one result per file, not per target — the README carries two regions and rendering them separately
  // made the second write revert the first.
  assert.equal(results.length, new Set(TARGETS.map((target) => target.file)).size);
  for (const result of results) {
    assert.equal(result.current, result.next, `${result.file} is out of date with the catalog`);
  }

  const sample = "before\n<!-- generated:rails -->\nOLD\n<!-- /generated -->\nafter\n";
  const replaced = replaceRegion(sample, "rails", "NEW");
  assert.match(replaced, /before/);
  assert.match(replaced, /after/);
  assert.match(replaced, /NEW/);
  assert.doesNotMatch(replaced, /OLD/);
});

test("a missing region marker is an error, not a silent no-op", async () => {
  const { replaceRegion } = await import("../dev/render-capabilities.ts");
  assert.throws(() => replaceRegion("no markers here", "rails", "x"), /missing region marker/);
});

// hazard: the README states a capability count in prose. It was already one behind the catalog when this
// test was written, so the number is asserted against the catalog rather than trusted. The floor count had
// drifted the same way in the other direction — "Five rules" above a table of six.
test("every count the README states matches what it counts", async () => {
  const catalog = JSON.parse(readFileSync(join(repoRoot, "capabilities", "catalog.json"), "utf8")) as {
    capabilities: unknown[];
  };
  const { FLOOR_RULE_IDS } = await import("../../src/core/floor/floor.catalog.ts");
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

  const rails = /(\d+) capabilities \|/.exec(readme);
  assert.ok(rails, "the README no longer states a capability count");
  assert.equal(
    Number(rails[1]),
    catalog.capabilities.length,
    "the README's capability count drifted from capabilities/catalog.json",
  );

  const floor = /(\d+) rules \|/.exec(readme);
  assert.ok(floor, "the README no longer states a floor rule count");
  assert.equal(
    Number(floor[1]),
    FLOOR_RULE_IDS.length,
    "the README's floor rule count drifted from the FloorRule union",
  );
});

// why: the README's whole promise is that the three tiers are exhaustive. A rail in the catalog that the
// generated region does not carry would make that promise false without failing anything else.
test("the README's rail table carries every capability's key and inspect route", () => {
  const catalog = JSON.parse(readFileSync(join(repoRoot, "capabilities", "catalog.json"), "utf8")) as {
    capabilities: { id: string; configPath: string; inspect: string }[];
  };
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const missing = catalog.capabilities
    .filter((cap) => !readme.includes(cap.configPath) || !readme.includes(cap.inspect))
    .map((cap) => cap.id);
  assert.deepEqual(missing, [], "capabilities absent from the README's rail table");
});

// hazard: three capabilities shipped with generated regions updated and concepts.md untouched, because
// check-docs-bundle validates OKF frontmatter rather than content. The operator document is where someone
// learns which key to write, so every catalog entry has to name its own configPath there.
test("concepts.md names the config key of every catalog capability", () => {
  const catalog = JSON.parse(readFileSync(join(repoRoot, "capabilities", "catalog.json"), "utf8")) as {
    capabilities: { id: string; configPath: string }[];
  };
  const concepts = readFileSync(join(repoRoot, "docs", "concepts.md"), "utf8");
  const missing = catalog.capabilities
    .filter((capability) => !concepts.includes(capability.configPath))
    .map((capability) => `${capability.id} (${capability.configPath})`);
  assert.deepEqual(missing, [], "capabilities absent from docs/concepts.md");
});

// hazard: the section this replaces advertised fields nothing read. Every field a project may now set has to
// be described where an operator looks, or the config is lying again in a new spelling.
test("concepts.md names every tunable obs field, and no more", () => {
  const concepts = readFileSync(join(repoRoot, "docs", "concepts.md"), "utf8");
  const defaults = readFileSync(join(repoRoot, "src", "core", "policy", "policy.defaults.ts"), "utf8");
  const block = defaults.slice(defaults.indexOf("obs: {"), defaults.indexOf("}", defaults.indexOf("obs: {")));
  const fields = [...block.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((match) => match[1] as string);
  assert.ok(fields.length >= 5, `expected the obs defaults block, parsed ${fields.length}`);
  const missing = fields.filter((field) => !concepts.includes(`obs.${field}`));
  assert.deepEqual(missing, [], "obs fields absent from docs/concepts.md");
});

// hazard: the deepest posture once had two spellings — one the CLI accepted, one the config field stored — and
// the documented word therefore matched no branch at all ([/decisions/ad-025.md](/decisions/ad-025.md)). A regression here is silent: the second name
// would work at whichever surface reintroduced it and be refused at every other. Decision records are excluded
// on purpose; they describe the defect and have to be able to name it.
test("no source file or operator-facing document carries a retired posture spelling", () => {
  const surfaces = [
    join(repoRoot, "src"),
    join(repoRoot, "bin"),
    join(repoRoot, "tools"),
    join(repoRoot, "skills"),
    join(repoRoot, "README.md"),
    join(repoRoot, "docs", "architecture.md"),
    join(repoRoot, "docs", "concepts.md"),
  ];
  const retired = ["heads-down", "headsDown"];

  const files: string[] = [];
  const walk = (path: string): void => {
    const entry = statSync(path);
    if (entry.isFile()) {
      files.push(path);
      return;
    }
    for (const child of readdirSync(path, { withFileTypes: true })) {
      // why: a test asserting a word is absent has to contain it, so tests are not their own subject.
      if (child.name === "__test__" || child.name === "node_modules" || child.name === "dist") {
        continue;
      }
      walk(join(path, child.name));
    }
  };
  for (const surface of surfaces) {
    walk(surface);
  }
  assert.ok(files.length > 100, `expected the source tree, walked ${files.length} files`);

  const hits = files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return retired.filter((word) => text.includes(word)).map((word) => `${file}: ${word}`);
  });
  assert.deepEqual(hits, []);
});

// hazard: honouring the legacy key would have been back-compat this project refuses ([/decisions/ad-003.md](/decisions/ad-003.md)), and leaving it
// in an example invites an operator to write something nothing reads.
test("no shipped config advertises the removed observability section", () => {
  for (const file of ["config.example.json", join(".tlc", "harness", "config.json")]) {
    const parsed = JSON.parse(readFileSync(join(repoRoot, file), "utf8")) as Record<string, unknown>;
    assert.equal("observability" in parsed, false, `${file} still carries the dead section`);
  }
});

/**
 * hazard: the wizard narrates three capabilities in prose and points at the generated table for the other
 * nineteen, which is the right split — and it means the narrated three can drift while every generated surface
 * stays correct. Both happened to the comment gate: it still described the `HEAD` diff base a decision had
 * already replaced, and it offered two modes after a third shipped. Nothing checked the hand-written half.
 */
test("a capability the init skill narrates names every mode the catalog offers", () => {
  const catalog = JSON.parse(readFileSync(join(repoRoot, "capabilities", "catalog.json"), "utf8")) as {
    capabilities: { id: string; configPath: string; asks?: string[] }[];
  };
  const skill = readFileSync(join(repoRoot, "skills", "harness-init", "SKILL.md"), "utf8");

  const missing: string[] = [];
  for (const capability of catalog.capabilities) {
    if (!skill.includes(capability.configPath)) {
      continue;
    }
    for (const ask of capability.asks ?? []) {
      const offered = ask.split(":")[1];
      if (offered === undefined || !offered.includes("|")) {
        continue;
      }
      for (const option of offered.split("|").map((word) => word.trim().replace(/[`"]/g, ""))) {
        if (option !== "" && !skill.includes(option)) {
          missing.push(`${capability.id}: ${option}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], "modes offered by the catalog and absent from the init skill");
});

/**
 * hazard: three surfaces list the floor rules and only two are generated. `docs/troubleshooting.md` names each
 * rule so an operator can go from a refusal on screen back to the reason, and a rule missing from it is a denial
 * with no explanation anywhere — the drift class a hand-written half always has
 * ([/decisions/ad-074.md](/decisions/ad-074.md)).
 */
test("troubleshooting names every floor rule, so no refusal is unexplained", async () => {
  const { FLOOR_RULES } = await import("../../src/core/floor/floor.catalog.ts");
  const guide = readFileSync(join(repoRoot, "docs", "troubleshooting.md"), "utf8");
  const missing = Object.keys(FLOOR_RULES).filter((rule) => !guide.includes(`\`${rule}\``));
  assert.deepEqual(missing, [], "floor rules absent from docs/troubleshooting.md");
});
