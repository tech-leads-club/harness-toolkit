import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProviderCapabilities, ProviderPolicyDefaults } from "../../../contracts/index.ts";
import { detectClaude } from "../../claude/claude.detect.ts";
import type { ProviderPort } from "../../provider.port.ts";
import { providers, resolveByHint, resolveFromRegistry } from "../../provider.registry.ts";
import { detectCodex } from "../codex.detect.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(HERE, "..", "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function fixturesIn(...segments: string[]): { name: string; payload: Record<string, unknown> }[] {
  const dir = join(...segments);
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => ({ name: entry, payload: readJson(join(dir, entry)) }));
}

const codexFixtures = fixturesIn(HERE, "fixtures");

/** why this subset: these are the fixtures carrying one of the four marks spec P3 AC1 names. */
const FINGERPRINTED = [
  "permission-request-bash.json",
  "post-compact.json",
  "pre-tool-use-apply-patch.json",
  "post-tool-use-apply-patch.json",
  "session-start.json",
  "session-end.json",
  "subagent-stop.json",
];

const foreignFixtures = [
  ...fixturesIn(PROVIDERS_DIR, "vscode", "__test__", "fixtures"),
  ...fixturesIn(PROVIDERS_DIR, "cursor", "__test__", "fixtures"),
  ...fixturesIn(PROVIDERS_DIR, "claude", "__test__", "fixtures"),
  ...fixturesIn(PROVIDERS_DIR, "opencode", "__test__", "fixtures", "legacy"),
  ...fixturesIn(PROVIDERS_DIR, "opencode", "__test__", "fixtures", "namespaced"),
];

function withHint<T>(hint: string | undefined, body: () => T): T {
  const previous = process.env.TLC_PROVIDER_HINT;
  if (hint === undefined) {
    delete process.env.TLC_PROVIDER_HINT;
  } else {
    process.env.TLC_PROVIDER_HINT = hint;
  }
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.TLC_PROVIDER_HINT;
    } else {
      process.env.TLC_PROVIDER_HINT = previous;
    }
  }
}

test("the fixture sets are non-empty, so the sweeps below assert something", () => {
  assert.ok(codexFixtures.length > 0);
  assert.ok(foreignFixtures.length > 0);
});

// spec P3 AC1: PermissionRequest or PostCompact, tool_name apply_patch, or a `.codex` transcript path.
test("a PermissionRequest payload is claimed with no hint set", () => {
  withHint(undefined, () => {
    assert.equal(detectCodex({ hook_event_name: "PermissionRequest", cwd: "/repo" }), true);
  });
});

test("a PostCompact payload is claimed with no hint set", () => {
  withHint(undefined, () => {
    assert.equal(detectCodex({ hook_event_name: "PostCompact", cwd: "/repo" }), true);
  });
});

test("an apply_patch tool name is claimed with no hint set", () => {
  withHint(undefined, () => {
    assert.equal(
      detectCodex({ hook_event_name: "PreToolUse", cwd: "/repo", tool_name: "apply_patch" }),
      true,
    );
  });
});

test("a .codex transcript path is claimed with no hint set", () => {
  withHint(undefined, () => {
    assert.equal(
      detectCodex({
        hook_event_name: "SessionStart",
        transcript_path: "/Users/dev/.codex/sessions/s.jsonl",
      }),
      true,
    );
  });
});

test("a subagent stop is claimed through its child's transcript path", () => {
  assert.equal(
    detectCodex({
      hook_event_name: "SubagentStop",
      cwd: "/repo",
      agent_transcript_path: "/Users/dev/.codex/sessions/agent_01.jsonl",
    }),
    true,
  );
});

// hazard: a substring test on ".codex" claims a directory that merely starts with those characters.
test("a path that only contains the characters .codex is not a Codex transcript", () => {
  assert.equal(
    detectCodex({ hook_event_name: "SessionStart", transcript_path: "/repo/my.codex-notes/s.jsonl" }),
    false,
  );
});

test("every fingerprinted fixture is claimed", () => {
  for (const name of FINGERPRINTED) {
    const fixture = codexFixtures.find((entry) => entry.name === name);
    assert.ok(fixture, `missing fixture ${name}`);
    assert.equal(detectCodex(fixture.payload), true, name);
  }
});

/**
 * The honest boundary of content detection on this host. Codex's remaining events are Claude's shape exactly, so
 * nothing in them says Codex — which is why the wiring launches with `--provider codex` and the hint, not this
 * detector, is what routes a real session (design §4).
 */
test("a Codex payload with no fingerprint is not claimed, and the hint is what covers it", () => {
  const bashBefore = codexFixtures.find((entry) => entry.name === "pre-tool-use-bash.json");
  assert.ok(bashBefore);
  assert.equal(detectCodex(bashBefore.payload), false);
  assert.equal(resolveByHint("codex", [stubPort("codex", detectCodex)]).provider?.name, "codex");
});

test("no other host's fixture is claimed", () => {
  for (const { name, payload } of foreignFixtures) {
    assert.equal(detectCodex(payload), false, name);
  }
});

test("non-objects are rejected rather than thrown on", () => {
  for (const raw of [null, undefined, 0, "PermissionRequest", true, [], [{ tool_name: "apply_patch" }]]) {
    assert.equal(detectCodex(raw), false, JSON.stringify(raw ?? null));
  }
});

// spec P3 AC2: when a hint is set and is not `claude`, the Claude detector returns false.
test("the Claude detector declines a Claude payload while a non-claude hint is set", () => {
  const claudeShaped = { hook_event_name: "SessionStart", cwd: "/repo" };
  withHint(undefined, () => {
    assert.equal(detectClaude(claudeShaped), true, "precondition: claimed with no hint");
  });
  withHint("vscode", () => {
    assert.equal(detectClaude(claudeShaped), false);
  });
  withHint("codex", () => {
    assert.equal(detectClaude(claudeShaped), false);
  });
});

test("the Claude detector still claims its own payload when the hint names claude", () => {
  withHint("claude", () => {
    assert.equal(detectClaude({ hook_event_name: "SessionStart", cwd: "/repo" }), true);
  });
});

test("a real VS Code payload is claimed by Claude with no hint, and declined once the hint names vscode", () => {
  const vscodePayload = fixturesIn(PROVIDERS_DIR, "vscode", "__test__", "fixtures").find(
    (entry) => entry.name === "pre-tool-use-terminal.json",
  );
  assert.ok(vscodePayload);
  withHint(undefined, () => {
    assert.equal(detectClaude(vscodePayload.payload), true);
  });
  withHint("vscode", () => {
    assert.equal(detectClaude(vscodePayload.payload), false);
  });
});

test("Claude declines a Codex-fingerprinted payload, so the two never both match", () => {
  withHint(undefined, () => {
    for (const name of FINGERPRINTED) {
      const fixture = codexFixtures.find((entry) => entry.name === name);
      assert.ok(fixture);
      assert.equal(detectClaude(fixture.payload), false, name);
    }
  });
});

function stubPort(name: string, detect: (raw: unknown) => boolean): ProviderPort {
  return {
    name,
    detect,
    capabilities: () => ({}) as ProviderCapabilities,
    policyDefaults: () => ({}) as ProviderPolicyDefaults,
    toEvent: () => null,
    render: () => ({ stdout: null, exitCode: 0 }),
    wiring: () => ({ target: "/tmp/x", kind: "cursor-hooks-json", strategy: "replace", entries: [] }),
  };
}

/**
 * why the real registry and not a stub: T13 registered `codexProvider`, so the order design §4 argues for is a
 * fact of `providers` rather than something this test constructs.
 */
function registryWithCodex(): readonly ProviderPort[] {
  return providers;
}

test("Codex sits ahead of Claude in the registry, which is the only tiebreak", () => {
  const names = registryWithCodex().map((provider) => provider.name);
  assert.ok(names.indexOf("codex") < names.indexOf("claude"), names.join(","));
});

test("every fingerprinted Codex fixture resolves to Codex with no hint set", () => {
  withHint(undefined, () => {
    const registry = registryWithCodex();
    for (const name of FINGERPRINTED) {
      const fixture = codexFixtures.find((entry) => entry.name === name);
      assert.ok(fixture);
      assert.equal(resolveFromRegistry(fixture.payload, registry).provider?.name, "codex", name);
    }
  });
});

test("an un-hinted Claude payload still resolves to Claude", () => {
  withHint(undefined, () => {
    const resolved = resolveFromRegistry(
      { hook_event_name: "PreToolUse", cwd: "/repo", tool_name: "Bash", tool_input: { command: "ls" } },
      registryWithCodex(),
    );
    assert.equal(resolved.provider?.name, "claude");
    assert.equal(resolved.ambiguous, false);
  });
});

test("a hinted VS Code payload resolves to VS Code, running no detector", () => {
  const registry = [
    ...registryWithCodex(),
    stubPort("vscode", () => {
      throw new Error("detect must not run when a hint is set");
    }),
  ];
  const resolved = resolveByHint("vscode", registry);
  assert.equal(resolved.provider?.name, "vscode");
  assert.equal(resolved.ambiguous, false);
});

/**
 * invariant: detection stays deterministic (PROV-28). Two matches would make `run.ts` record `adapter.ambiguous`
 * on a payload that has exactly one right owner.
 */
test("no fixture from any host resolves ambiguously against the full registry", () => {
  withHint(undefined, () => {
    const registry = registryWithCodex();
    for (const { name, payload } of [...codexFixtures, ...foreignFixtures]) {
      assert.equal(resolveFromRegistry(payload, registry).ambiguous, false, name);
    }
  });
});
