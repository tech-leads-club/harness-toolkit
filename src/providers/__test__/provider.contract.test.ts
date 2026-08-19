import assert from "node:assert/strict";
import { test } from "node:test";
import type { Decision, HarnessEvent, ProviderCapabilities, Rendered } from "../../contracts/index.ts";
import { isEffortLevel } from "../../contracts/index.ts";
import type { ProviderPort } from "../provider.port.ts";
import { providers, resolveFromRegistry, resolveProvider } from "../provider.registry.ts";

const BOOLEAN_CAPABILITY_FLAGS: readonly (keyof ProviderCapabilities)[] = [
  "enforcesHooks",
  "sessionEnv",
  "nativeLoopCounter",
  "dedicatedShellEvent",
  "toolInputRewrite",
  "toolOutputRewrite",
  "contextAtToolBefore",
  "contextAtToolAfter",
  "contextAtStop",
  "toolOutputAtAfter",
  "sessionStartContextReliable",
  "usageInPayload",
  "effortSignal",
  "thoughtEvent",
];

const CAPABILITY_FLAG_COUNT = BOOLEAN_CAPABILITY_FLAGS.length + 1;

function assertSatisfiesContract(provider: ProviderPort): void {
  assert.equal(typeof provider.name, "string", "name is a string");
  assert.ok(provider.name.length > 0, "name is non-empty");
  assert.equal(typeof provider.detect, "function");
  assert.equal(typeof provider.capabilities, "function");
  assert.equal(typeof provider.policyDefaults, "function");
  assert.equal(typeof provider.toEvent, "function");
  assert.equal(typeof provider.render, "function");
  assert.equal(typeof provider.wiring, "function");

  const policyDefaults = provider.policyDefaults();
  /**
   * invariant: no adapter ships a model allowlist. An empty project list used to fall back to one, so a spawn could
   * be refused by a list nobody wrote — and it had already gone stale
   * ([/decisions/ad-053.md](/decisions/ad-053.md)).
   */
  assert.ok(
    !("allowedModels" in policyDefaults),
    `${provider.name}.policyDefaults() must not ship an allowlist`,
  );
  assert.ok(
    Array.isArray(policyDefaults.untrustedTools),
    `${provider.name}.policyDefaults().untrustedTools is an array`,
  );
  for (const tool of policyDefaults.untrustedTools) {
    assert.equal(
      typeof tool,
      "string",
      `${provider.name}.policyDefaults().untrustedTools entries are strings`,
    );
  }
  assert.ok(
    Array.isArray(policyDefaults.blockedPatterns),
    `${provider.name}.policyDefaults().blockedPatterns is an array`,
  );
  for (const pattern of policyDefaults.blockedPatterns) {
    assert.equal(
      typeof pattern,
      "string",
      `${provider.name}.policyDefaults().blockedPatterns entries are strings`,
    );
  }
  assert.ok(
    policyDefaults.minEffort === null || isEffortLevel(policyDefaults.minEffort),
    `${provider.name}.policyDefaults().minEffort is null or a valid effort level`,
  );

  const capabilities = provider.capabilities();
  assert.equal(
    Object.keys(capabilities).length,
    CAPABILITY_FLAG_COUNT,
    `exactly ${CAPABILITY_FLAG_COUNT} capability flags`,
  );
  for (const flag of BOOLEAN_CAPABILITY_FLAGS) {
    assert.equal(typeof capabilities[flag], "boolean", `${provider.name}.capabilities().${flag} is boolean`);
  }
  assert.ok(
    Array.isArray(capabilities.askSupportedOn),
    `${provider.name}.capabilities().askSupportedOn is an array`,
  );
  for (const kind of capabilities.askSupportedOn) {
    assert.equal(typeof kind, "string", `${provider.name}.capabilities().askSupportedOn entries are strings`);
  }

  const fabricated: HarnessEvent = {
    provider: provider.name,
    event: "stop",
    sessionKey: `${provider.name}-contract-probe`,
    projectDir: "/tmp",
    raw: {},
  };
  const rendered: Rendered = provider.render({ kind: "abstain" }, fabricated);
  assert.equal(typeof rendered.exitCode, "number");
  assert.ok(rendered.stdout === null || typeof rendered.stdout === "string");

  const wiring = provider.wiring({ launcherPath: "/tmp/tlc-exec.mjs" });
  assert.ok(wiring.target.length > 0, "wiring target is non-empty");
  assert.ok(wiring.strategy === "replace" || wiring.strategy === "merge", "strategy is replace or merge");
}

function makeFixtureProvider(): ProviderPort {
  const capabilities: ProviderCapabilities = {
    enforcesHooks: true,
    askSupportedOn: ["tool.before", "shell.before", "mcp.before"],
    sessionEnv: true,
    nativeLoopCounter: true,
    dedicatedShellEvent: true,
    toolInputRewrite: true,
    toolOutputRewrite: true,
    contextAtToolBefore: true,
    contextAtToolAfter: true,
    contextAtStop: true,
    sessionStartContextReliable: true,
    toolOutputAtAfter: false,
    usageInPayload: true,
    effortSignal: true,
    thoughtEvent: true,
  };
  return {
    name: "fixture-provider",
    detect(raw: unknown): boolean {
      return Boolean(raw) && typeof raw === "object" && (raw as Record<string, unknown>).fixture === true;
    },
    capabilities(): ProviderCapabilities {
      return capabilities;
    },
    policyDefaults() {
      return {
        blockedPatterns: ["-fast(?:$|[^a-z0-9])"],
        minEffort: null,
        untrustedTools: ["FixtureFetch"],
      };
    },
    toEvent(raw: Record<string, unknown>): HarnessEvent | null {
      if (raw.hook_event_name !== "fixtureStop") {
        return null;
      }
      return {
        provider: "fixture-provider",
        event: "stop",
        sessionKey: "fixture-provider-default",
        projectDir: "/tmp",
        raw,
      };
    },
    render(decision: Decision, _event: HarnessEvent): Rendered {
      return { stdout: decision.kind === "abstain" ? null : JSON.stringify(decision), exitCode: 0 };
    },
    wiring() {
      return { target: "/tmp/fixture.json", strategy: "replace" as const, entries: [] };
    },
  };
}

test("registry starts with only genuinely registered providers, each satisfying the port contract", () => {
  for (const provider of providers) {
    assertSatisfiesContract(provider);
  }
});

test("resolveFromRegistry: zero matches returns null without throwing", () => {
  const result = resolveFromRegistry({ nothing: true }, []);
  assert.equal(result.provider, null);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.matchedNames, []);
});

test("resolveFromRegistry: exactly one match returns that provider, not ambiguous", () => {
  const fixture = makeFixtureProvider();
  const result = resolveFromRegistry({ fixture: true }, [fixture]);
  assert.equal(result.provider, fixture);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.matchedNames, ["fixture-provider"]);
});

test("resolveFromRegistry: two matches returns the earlier entry and reports ambiguity", () => {
  const first = makeFixtureProvider();
  const second: ProviderPort = { ...makeFixtureProvider(), name: "fixture-provider-2" };
  const result = resolveFromRegistry({ fixture: true }, [first, second]);
  assert.equal(result.provider, first);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.matchedNames, ["fixture-provider", "fixture-provider-2"]);
});

test("resolveFromRegistry: registry order is deterministic — reversing the array changes the winner", () => {
  const first = makeFixtureProvider();
  const second: ProviderPort = { ...makeFixtureProvider(), name: "fixture-provider-2" };
  const forward = resolveFromRegistry({ fixture: true }, [first, second]);
  const reversed = resolveFromRegistry({ fixture: true }, [second, first]);
  assert.equal(forward.provider?.name, "fixture-provider");
  assert.equal(reversed.provider?.name, "fixture-provider-2");
});

test("resolveProvider delegates to the real registry", () => {
  const result = resolveProvider({ nothing: true });
  assert.equal(result.provider, providers.find((p) => p.detect({ nothing: true })) ?? null);
});

test("a fixture provider satisfies the full port contract", () => {
  assertSatisfiesContract(makeFixtureProvider());
});

test("a fixture provider added to the registry alone is resolvable and passes the same contract — no other file changed", () => {
  const fixture = makeFixtureProvider();
  providers.push(fixture);
  try {
    const result = resolveProvider({ fixture: true });
    assert.equal(result.provider, fixture);
    assertSatisfiesContract(fixture);
  } finally {
    const index = providers.indexOf(fixture);
    if (index >= 0) {
      providers.splice(index, 1);
    }
  }
});

test("detect never throws on null", () => {
  const fixture = makeFixtureProvider();
  assert.doesNotThrow(() => fixture.detect(null));
  assert.equal(fixture.detect(null), false);
});

test("detect never throws on a non-object", () => {
  const fixture = makeFixtureProvider();
  assert.doesNotThrow(() => fixture.detect("not an object"));
  assert.equal(fixture.detect("not an object"), false);
});

test("detect never throws on an empty object", () => {
  const fixture = makeFixtureProvider();
  assert.doesNotThrow(() => fixture.detect({}));
  assert.equal(fixture.detect({}), false);
});

test("toEvent returns null for an unrecognized payload rather than throwing", () => {
  const fixture = makeFixtureProvider();
  assert.doesNotThrow(() => fixture.toEvent({ hook_event_name: "unknown" }));
  assert.equal(fixture.toEvent({ hook_event_name: "unknown" }), null);
});

test("provider name is safe as a state-file key segment (no whitespace, no slashes)", () => {
  const fixture = makeFixtureProvider();
  assert.doesNotMatch(fixture.name, /[\s/\\]/);
});

test("render never throws for an abstain decision", () => {
  const fixture = makeFixtureProvider();
  const event: HarnessEvent = {
    provider: "fixture-provider",
    event: "stop",
    sessionKey: "fixture-provider-default",
    projectDir: "/tmp",
    raw: {},
  };
  assert.doesNotThrow(() => fixture.render({ kind: "abstain" }, event));
  assert.equal(fixture.render({ kind: "abstain" }, event).exitCode, 0);
});
