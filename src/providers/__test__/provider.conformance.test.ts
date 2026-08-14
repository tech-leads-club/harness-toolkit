import assert from "node:assert/strict";
import { test } from "node:test";
import { type Decision, HARNESS_EVENT_KINDS, type HarnessEvent } from "../../contracts/index.ts";
import { providers } from "../index.ts";

/**
 * why: provider neutrality is the central promise of this harness, and it was asserted by goldens covering one
 * decision kind out of seven. A provider that throws on an unexercised combination breaks a real turn, and nothing
 * caught it ([/decisions/ad-028.md](/decisions/ad-028.md)).
 *
 * invariant: the matrix is driven from the registry and from the event-kind list, so a provider or an event kind
 * added later is covered without anyone editing this file.
 */
const DECISIONS: Decision[] = [
  { kind: "abstain" },
  { kind: "allow" },
  { kind: "deny", reason: "denied because the rail said so", rule: "some-rule" },
  { kind: "ask", reason: "asking because the posture said so", rule: "some-rule" },
  { kind: "context", text: "injected context", env: { HARNESS_ACTIVE: "1" } },
  { kind: "continue", text: "BLOCKED: keep going" },
  { kind: "rewriteInput", input: { command: "safer" }, reason: "rewritten" },
];

function eventOf(kind: HarnessEvent["event"], provider: string): HarnessEvent {
  return {
    event: kind,
    provider,
    sessionKey: `${provider}-session-a`,
    projectDir: "/tmp/does-not-need-to-exist",
    toolName: "Bash",
    command: "ls -la",
    raw: {},
  };
}

test("render is total across every event kind, every decision kind and every provider", () => {
  let combinations = 0;
  for (const provider of providers) {
    for (const kind of HARNESS_EVENT_KINDS) {
      for (const decision of DECISIONS) {
        combinations += 1;
        assert.doesNotThrow(
          () => provider.render(decision, eventOf(kind, provider.name)),
          `${provider.name} threw on ${decision.kind} at ${kind}`,
        );
      }
    }
  }
  // why: asserts the matrix actually ran. A loop over an empty registry passes silently and proves nothing.
  assert.equal(combinations, providers.length * HARNESS_EVENT_KINDS.length * DECISIONS.length);
  assert.ok(combinations > 100, `expected a real matrix, ran ${combinations}`);
});

// invariant: a refusal must carry its reason to the operator. A provider that renders a deny without the reason
// leaves a person staring at a blocked action with no explanation.
test("a deny or ask reaches every provider's output carrying its reason", () => {
  for (const provider of providers) {
    for (const decision of DECISIONS.filter((d) => d.kind === "deny" || d.kind === "ask")) {
      const rendered = provider.render(decision, eventOf("shell.before", provider.name));
      const reason = decision.kind === "deny" || decision.kind === "ask" ? decision.reason : "";
      assert.ok(
        rendered.stdout?.includes(reason),
        `${provider.name} dropped the reason for ${decision.kind}`,
      );
    }
  }
});

// invariant: an abstain means "this rail has nothing to say". A provider that turned that into an approval would
// convert silence into consent on every event no rail cared about.
test("abstain never renders anything that reads as an approval", () => {
  for (const provider of providers) {
    for (const kind of HARNESS_EVENT_KINDS) {
      const rendered = provider.render({ kind: "abstain" }, eventOf(kind, provider.name));
      if (rendered.stdout === null) {
        continue;
      }
      assert.doesNotMatch(
        rendered.stdout,
        /"permission"\s*:\s*"allow"|"permissionDecision"\s*:\s*"allow"/,
        `${provider.name} rendered abstain as an approval at ${kind}`,
      );
    }
  }
});

// invariant: exit code is never a policy channel ([/decisions/ad-004.md](/decisions/ad-004.md)). A provider signalling a decision through it would put
// policy in a place `degrade` cannot see and the host may not read.
test("every render returns exit code 0, whatever the decision", () => {
  for (const provider of providers) {
    for (const decision of DECISIONS) {
      assert.equal(
        provider.render(decision, eventOf("tool.before", provider.name)).exitCode,
        0,
        `${provider.name} used the exit code for ${decision.kind}`,
      );
    }
  }
});
