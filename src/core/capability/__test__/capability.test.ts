import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HARNESS_EVENT_KINDS } from "../../../contracts/harness-event.ts";
import {
  formatAvailableInventory,
  formatCapabilityDigest,
  formatDoctorWarn,
  isAvailableNotEnabled,
  listAvailableNotEnabled,
  listNewlyAnnounceable,
  resolveConfigPath,
} from "../capability.service.ts";
import {
  loadCatalog,
  readProjectPolicyRaw,
  readProjectPolicyStatus,
  readRuntimeSeen,
  writeRuntimeSeen,
} from "../capability.store.ts";
import {
  type CapabilityCatalog,
  type CatalogCapability,
  ENABLE_HINT,
  SUMMARY_MAX_CHARS,
} from "../capability.types.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "capability-"));
}

function writePolicy(dir: string, policy: unknown): void {
  mkdirSync(join(dir, ".tlc", "harness"), { recursive: true });
  writeFileSync(join(dir, ".tlc", "harness", "config.json"), JSON.stringify(policy));
}

function capability(overrides: Partial<CatalogCapability> = {}): CatalogCapability {
  return {
    id: "cap",
    configPath: "grind.enabled",
    title: "Cap",
    summary: "s",
    benefit: "b",
    tradeOff: "t",
    defaultOn: false,
    sinceCatalogVersion: 1,
    fires: ["stop"],
    verdict: "block-stop",
    inspect: "tlc harness obs report",
    ...overrides,
  };
}

test("the shipped catalog loads and every entry is well formed", () => {
  const catalog = loadCatalog(REPO_ROOT);
  assert.ok(catalog, "catalog must load from the runtime root");
  assert.ok(catalog.catalogVersion >= 1);
  assert.ok(Array.isArray(catalog.capabilities) && catalog.capabilities.length > 0);
  for (const cap of catalog.capabilities) {
    assert.equal(typeof cap.id, "string");
    assert.equal(typeof cap.configPath, "string");
    assert.equal(typeof cap.title, "string");
    assert.equal(typeof cap.benefit, "string");
    assert.equal(typeof cap.tradeOff, "string");
    assert.equal(typeof cap.defaultOn, "boolean");
    assert.ok(cap.sinceCatalogVersion >= 1);
  }
});

test("no capability is newer than the catalog that carries it", () => {
  const catalog = loadCatalog(REPO_ROOT);
  assert.ok(catalog);
  for (const cap of catalog.capabilities) {
    // why: the digest announces what `sinceCatalogVersion > seen` selects, and `seen` is set to the catalog's own
    // version. An entry above that is announced on every single update forever — `observe` shipped at 9 in a
    // catalog at 8 and did exactly that, which is the failure AD-034 removed from the decision digest.
    assert.ok(
      cap.sinceCatalogVersion <= catalog.catalogVersion,
      `${cap.id} is since ${cap.sinceCatalogVersion} but the catalog is ${catalog.catalogVersion}`,
    );
  }
});

test("every capability says when it fires, what it does, and where to see it", () => {
  const catalog = loadCatalog(REPO_ROOT);
  assert.ok(catalog);
  const verdicts = new Set(["deny", "ask", "block-stop", "follow-up", "context", "record"]);
  for (const cap of catalog.capabilities) {
    assert.ok(cap.fires.length > 0, `${cap.id} declares no event`);
    for (const kind of cap.fires) {
      // why: a free-text answer to "when does this fire?" is one rename away from naming an event that no
      // handler dispatches, and the README would keep printing it.
      assert.ok(HARNESS_EVENT_KINDS.includes(kind), `${cap.id} fires on unknown event ${kind}`);
    }
    assert.ok(verdicts.has(cap.verdict), `${cap.id} has verdict ${cap.verdict}`);
    assert.ok(cap.inspect.trim().length > 0, `${cap.id} names nothing that shows it`);
    assert.ok(cap.summary.trim().length > 0, `${cap.id} has no one-line summary`);
    assert.ok(
      cap.summary.length <= SUMMARY_MAX_CHARS,
      `${cap.id} summary is ${cap.summary.length} chars, over the ${SUMMARY_MAX_CHARS} the table cell allows`,
    );
  }
});

test("catalog copy stays stack-agnostic", () => {
  const catalog = loadCatalog(REPO_ROOT);
  assert.ok(catalog);
  for (const cap of catalog.capabilities) {
    assert.equal(/biome|vitest|pytest|npm |bun /i.test(`${cap.benefit} ${cap.tradeOff}`), false);
  }
});

test("loadCatalog returns null when the catalog is absent", () => {
  const dir = tempProject();
  try {
    assert.equal(loadCatalog(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectPolicyRaw returns null when no policy exists", () => {
  const dir = tempProject();
  try {
    assert.equal(readProjectPolicyRaw(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectPolicyStatus distinguishes absent from malformed", async () => {
  const { projectConfigPath } = await import("../../../platform/paths.ts");
  const dir = tempProject();
  try {
    assert.deepEqual(readProjectPolicyStatus(dir), { status: "absent" });

    const path = projectConfigPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not valid json,");
    const malformed = readProjectPolicyStatus(dir);
    assert.equal(malformed.status, "malformed");
    if (malformed.status === "malformed") {
      assert.ok(malformed.error.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectPolicyStatus strips $schema from a parsed config", async () => {
  const { projectConfigPath } = await import("../../../platform/paths.ts");
  const dir = tempProject();
  try {
    const path = projectConfigPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ $schema: "https://unpkg.com/example/schema.json", mode: "solo" }));

    const result = readProjectPolicyStatus(dir);
    assert.equal(result.status, "parsed");
    if (result.status === "parsed") {
      assert.equal(Object.hasOwn(result.value, "$schema"), false);
      assert.equal(result.value.mode, "solo");
    }
    // why: the existing narrower reader must keep working — same file, same $schema-free result.
    assert.deepEqual(readProjectPolicyRaw(dir), { mode: "solo" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfigPath walks a nested path and tolerates a missing branch", () => {
  const policy = { intelligence: { lessons: { enabled: true } } };
  assert.equal(resolveConfigPath(policy, "intelligence.lessons.enabled"), true);
  assert.equal(resolveConfigPath(policy, "intelligence.missing.enabled"), undefined);
  assert.equal(resolveConfigPath(policy, "grind.enabled"), undefined);
});

test("a default-off capability counts as not enabled unless explicitly true", () => {
  const cap = capability({ defaultOn: false, configPath: "grind.enabled" });
  assert.equal(isAvailableNotEnabled({}, cap), true);
  assert.equal(isAvailableNotEnabled({ grind: { enabled: false } }, cap), true);
  assert.equal(isAvailableNotEnabled({ grind: { enabled: true } }, cap), false);
});

test("a default-on capability counts as not enabled only when explicitly false", () => {
  const cap = capability({ defaultOn: true, configPath: "intelligence.gapFeedback" });
  assert.equal(isAvailableNotEnabled({}, cap), false);
  assert.equal(isAvailableNotEnabled({ intelligence: { gapFeedback: false } }, cap), true);
  assert.equal(isAvailableNotEnabled({ intelligence: { gapFeedback: true } }, cap), false);
});

test("listAvailableNotEnabled keeps the off ones and drops the enabled one", () => {
  const grind = capability({ id: "grind", configPath: "grind.enabled", defaultOn: false });
  const ship = capability({ id: "shipGate", configPath: "shipGate.enabled", defaultOn: false });
  const catalog: CapabilityCatalog = { catalogVersion: 1, capabilities: [grind, ship] };
  const off = listAvailableNotEnabled({ shipGate: { enabled: true } }, catalog);
  assert.deepEqual(
    off.map((c) => c.id),
    ["grind"],
  );
});

test("listNewlyAnnounceable only surfaces capabilities newer than what was seen", () => {
  const older = capability({ id: "older", sinceCatalogVersion: 1 });
  const newer = capability({ id: "newer", configPath: "shipGate.enabled", sinceCatalogVersion: 3 });
  const catalog: CapabilityCatalog = { catalogVersion: 3, capabilities: [older, newer] };
  assert.deepEqual(
    listNewlyAnnounceable({}, catalog, 0).map((c) => c.id),
    ["older", "newer"],
  );
  assert.deepEqual(
    listNewlyAnnounceable({}, catalog, 2).map((c) => c.id),
    ["newer"],
  );
  assert.equal(listNewlyAnnounceable({}, catalog, 3).length, 0);
});

test("the digest names each capability with its benefit, trade-off and the enable hint", () => {
  const digest = formatCapabilityDigest([capability({ title: "Grind (lint/test on stop)" })]);
  assert.match(digest, /Grind \(lint\/test on stop\)/);
  assert.match(digest, /Benefit:/);
  assert.match(digest, /Trade-off:/);
  assert.ok(digest.includes(ENABLE_HINT));
});

// hazard: this asserted the string starts with "WARN:", which is what made an operator read the word twice — the row
// it lands in already carries its level ([/decisions/ad-034.md](/decisions/ad-034.md)).
test("the doctor detail carries the trade-off and the hint, and does not restate its own level", () => {
  const cap = capability({ title: "Grind", tradeOff: "slower stops" });
  const warn = formatDoctorWarn(cap);
  assert.equal(warn.startsWith("WARN:"), false);
  assert.ok(warn.includes("Grind"));
  assert.ok(warn.includes("slower stops"));
  assert.ok(warn.includes(ENABLE_HINT));
});

// why: one inventory row replaces a wall of warnings. The ids are enough — `update` lists each with its benefit and
// trade-off, which is where an operator actually chooses.
test("the inventory names the count, the ids and how to enable", () => {
  const line = formatAvailableInventory([
    capability({ id: "shipGate", title: "Ship gate" }),
    capability({ id: "observe", title: "Observation" }),
  ]);
  assert.match(line, /^2 available and not enabled: shipGate, observe\./);
  assert.ok(line.includes(ENABLE_HINT));
});

test("runtime-seen starts at zero, survives a corrupt file, and round-trips", async () => {
  const dir = tempProject();
  try {
    writePolicy(dir, {});
    assert.equal(readRuntimeSeen(dir).catalogVersion, 0);

    mkdirSync(join(dir, ".tlc", "harness", "state"), { recursive: true });
    writeFileSync(join(dir, ".tlc", "harness", "state", "runtime-seen.json"), "{not-json");
    assert.equal(readRuntimeSeen(dir).catalogVersion, 0);

    await writeRuntimeSeen(dir, 7);
    assert.equal(readRuntimeSeen(dir).catalogVersion, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("announcing once per catalog bump: after recording the version nothing is new", async () => {
  const dir = tempProject();
  try {
    writePolicy(dir, {});
    const catalog: CapabilityCatalog = { catalogVersion: 2, capabilities: [capability()] };
    assert.equal(listNewlyAnnounceable({}, catalog, readRuntimeSeen(dir).catalogVersion).length, 1);
    await writeRuntimeSeen(dir, catalog.catalogVersion);
    assert.equal(listNewlyAnnounceable({}, catalog, readRuntimeSeen(dir).catalogVersion).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
