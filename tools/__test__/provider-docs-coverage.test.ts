import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessEvent, ProviderCapabilities, Rendered } from "../../src/contracts/index.ts";
import type { ProviderPort } from "../../src/providers/provider.port.ts";
import { providers } from "../../src/providers/provider.registry.ts";
import { renderAll, renderCapabilityTable, renderEventMappingTable } from "../dev/render-provider-docs.ts";

// hazard: the whole point of a generated doc is that it cannot silently drift from the code it describes.
// A check that only ever passes proves nothing — this file's second test flips a capability at runtime,
// with no matching re-render, and confirms the same drift check catches it.
test("every provider doc's generated regions match a fresh render of its own code", async () => {
  const results = await renderAll();
  assert.equal(results.length, providers.length);
  for (const result of results) {
    assert.equal(result.current, result.next, `${result.file} is out of date with its provider's code`);
  }
});

function makeDriftFixture(name: string, capabilities: () => ProviderCapabilities): ProviderPort {
  return {
    name,
    detect: () => false,
    capabilities,
    policyDefaults: () => ({ blockedPatterns: [], minEffort: null, untrustedTools: [] }),
    toEvent: (): HarnessEvent | null => null,
    render: (): Rendered => ({ stdout: null, exitCode: 0 }),
    wiring: () => ({ target: "/tmp/fixture-drift.json", strategy: "replace" as const, entries: [] }),
    wiringTargets: () => ["/tmp/fixture-drift.json"],
  };
}

test("a capability flip with no matching re-render makes renderAll report that provider's doc as stale", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "provider-docs-coverage-"));
  const name = "fixture-drift";
  let sessionEnv = false;
  const fixture = makeDriftFixture(name, () => ({
    enforcesHooks: true,
    askSupportedOn: [],
    sessionEnv,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: false,
    toolOutputRewriteOn: [],
    contextAtToolBefore: false,
    contextAtToolAfter: false,
    contextAtStop: false,
    sessionStartContextReliable: false,
    toolOutputAtAfter: false,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  }));

  providers.push(fixture);
  try {
    mkdirSync(join(scratch, "docs", "providers"), { recursive: true });
    mkdirSync(join(scratch, "src", "providers", name), { recursive: true });
    writeFileSync(
      join(scratch, "src", "providers", name, `${name}.inbound.ts`),
      'export const EVENT_KIND_BY_HOOK = { stop: "stop" };\n',
      "utf8",
    );
    writeFileSync(
      join(scratch, "docs", "providers", `${name}.md`),
      [
        "# fixture-drift",
        "",
        "<!-- generated:capabilities -->",
        "",
        "<!-- /generated -->",
        "",
        "<!-- generated:event-mapping -->",
        "",
        "<!-- /generated -->",
        "",
      ].join("\n"),
      "utf8",
    );

    const seeded = await renderAll(scratch);
    const own = seeded.find((result) => result.file.endsWith(`${name}.md`));
    assert.ok(own, "expected a render result for the fixture provider");
    writeFileSync(join(scratch, own.file), own.next, "utf8");

    const inSync = await renderAll(scratch);
    const inSyncOwn = inSync.find((result) => result.file.endsWith(`${name}.md`));
    assert.equal(inSyncOwn?.current, inSyncOwn?.next, "freshly seeded doc should not report drift");

    sessionEnv = true;
    const drifted = await renderAll(scratch);
    const driftedOwn = drifted.find((result) => result.file.endsWith(`${name}.md`));
    assert.notEqual(
      driftedOwn?.current,
      driftedOwn?.next,
      "a flipped capability with no re-render must make the doc report as stale",
    );
  } finally {
    const index = providers.indexOf(fixture);
    if (index >= 0) {
      providers.splice(index, 1);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

// hazard: `loadInboundModule` dynamically imports the provider's inbound module by file URL, and Node's ESM
// loader caches an import by URL for the life of the process — rewriting the same file on disk and
// re-importing it returns the first, cached module. A committed doc authored to already predate the code's
// current event mapping, checked with a single renderAll call, sidesteps that entirely.
const STATIC_CAPABILITIES: ProviderCapabilities = {
  enforcesHooks: true,
  askSupportedOn: [],
  sessionEnv: false,
  nativeLoopCounter: false,
  dedicatedShellEvent: false,
  toolInputRewrite: false,
  toolOutputRewriteOn: [],
  contextAtToolBefore: false,
  contextAtToolAfter: false,
  contextAtStop: false,
  sessionStartContextReliable: false,
  toolOutputAtAfter: false,
  usageInPayload: false,
  effortSignal: false,
  thoughtEvent: false,
};

test("an event-mapping entry the code added, with no matching re-render, makes renderAll report the doc as stale", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "provider-docs-coverage-"));
  const name = "fixture-event-drift";
  const fixture = makeDriftFixture(name, () => STATIC_CAPABILITIES);

  providers.push(fixture);
  try {
    mkdirSync(join(scratch, "docs", "providers"), { recursive: true });
    mkdirSync(join(scratch, "src", "providers", name), { recursive: true });
    writeFileSync(
      join(scratch, "src", "providers", name, `${name}.inbound.ts`),
      'export const EVENT_KIND_BY_HOOK = { stop: "stop", sessionEnd: "session.end" };\n',
      "utf8",
    );

    const staleEventMapping = renderEventMappingTable({ EVENT_KIND_BY_HOOK: { stop: "stop" } });
    const capabilitiesTable = renderCapabilityTable(STATIC_CAPABILITIES);
    writeFileSync(
      join(scratch, "docs", "providers", `${name}.md`),
      [
        "# fixture-event-drift",
        "",
        "<!-- generated:capabilities -->",
        "",
        capabilitiesTable,
        "",
        "<!-- /generated -->",
        "",
        "<!-- generated:event-mapping -->",
        "",
        staleEventMapping,
        "",
        "<!-- /generated -->",
        "",
      ].join("\n"),
      "utf8",
    );

    const results = await renderAll(scratch);
    const own = results.find((result) => result.file.endsWith(`${name}.md`));
    assert.notEqual(
      own?.current,
      own?.next,
      "an event-mapping entry the code added, with no matching re-render, must make the doc report as stale",
    );
  } finally {
    const index = providers.indexOf(fixture);
    if (index >= 0) {
      providers.splice(index, 1);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
