import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { commandSegments, detectUntrustedRead } from "../untrusted.detect.ts";
import {
  evaluateUntrustedContent,
  framingMessage,
  resolveCommandPatterns,
  resolveTools,
} from "../untrusted.service.ts";
import { clearFramingMarker, wasFramingInjected } from "../untrusted.store.ts";
import { DEFAULT_UNTRUSTED_COMMAND_PATTERNS, type UntrustedPolicyConfig } from "../untrusted.types.ts";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-untrusted-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const ON: UntrustedPolicyConfig = { enabled: true, mode: "frame", extraTools: [], extraCommandPatterns: [] };
const OFF: UntrustedPolicyConfig = {
  enabled: false,
  mode: "frame",
  extraTools: [],
  extraCommandPatterns: [],
};
const TOOLS = ["WebFetch", "WebSearch"];

describe("detectUntrustedRead", () => {
  const base = { tools: TOOLS, commandPatterns: DEFAULT_UNTRUSTED_COMMAND_PATTERNS };

  test("every MCP result counts, since the server is not this repository", () => {
    const hit = detectUntrustedRead({ ...base, event: "mcp.after", toolName: "some__server__call" });
    assert.equal(hit?.source, "mcp");
    assert.equal(hit?.detail, "some__server__call");
  });

  test("a listed tool counts regardless of letter case", () => {
    assert.equal(detectUntrustedRead({ ...base, event: "tool.after", toolName: "webfetch" })?.source, "web");
  });

  test("an unlisted tool does not count", () => {
    assert.equal(detectUntrustedRead({ ...base, event: "tool.after", toolName: "Read" }), null);
  });

  test("a command that reads a pull request or an issue counts", () => {
    assert.equal(
      detectUntrustedRead({ ...base, event: "shell.after", command: "gh pr view 12 --json body" })?.source,
      "shell",
    );
    assert.equal(
      detectUntrustedRead({ ...base, event: "shell.after", command: "curl https://example.com" })?.detail,
      "curl",
    );
  });

  test("an ordinary command does not count", () => {
    assert.equal(detectUntrustedRead({ ...base, event: "shell.after", command: "npm test" }), null);
  });

  test("a pattern later in a pipeline still counts", () => {
    assert.equal(
      detectUntrustedRead({ ...base, event: "shell.after", command: "git log && gh issue view 3" })?.source,
      "shell",
    );
    assert.equal(
      detectUntrustedRead({ ...base, event: "shell.after", command: "curl -s x | jq ." })?.source,
      "shell",
    );
  });

  // hazard: a substring match reads the pattern out of a heredoc or a quoted argument and claims content was
  // fetched that never was. This repository documents the patterns, so its own docs triggered the rail.
  test("a pattern quoted, grepped or inside a heredoc is not a read", () => {
    for (const command of [
      'echo "curl https://example.com"',
      'grep -rn "gh api" docs/',
      "python3 - <<'PY'\nprint(\"gh pr view\")\nPY",
      "rg --fixed-strings 'wget'",
    ]) {
      assert.equal(
        detectUntrustedRead({ ...base, event: "shell.after", command }),
        null,
        `should not match: ${command}`,
      );
    }
  });

  test("commandSegments splits on the separators a shell actually honours", () => {
    assert.deepEqual(commandSegments("a && b || c | d ; e\nf"), ["a", "b", "c", "d", "e", "f"]);
    assert.deepEqual(commandSegments("   "), []);
  });

  // hazard: detection is declared, so an event the rail was never wired for must not silently match.
  test("an unrelated event kind never matches", () => {
    assert.equal(detectUntrustedRead({ ...base, event: "edit.after", toolName: "WebFetch" }), null);
  });
});

describe("resolveTools / resolveCommandPatterns", () => {
  test("the operator's extras extend the provider's list rather than replacing it", () => {
    const tools = resolveTools({ ...ON, extraTools: ["MyFetcher"] }, TOOLS);
    assert.deepEqual(tools, ["WebFetch", "WebSearch", "MyFetcher"]);
  });

  test("the default command patterns are always present", () => {
    const patterns = resolveCommandPatterns({ ...ON, extraCommandPatterns: ["aws s3 cp"] });
    assert.ok(patterns.includes("gh pr view"));
    assert.ok(patterns.includes("aws s3 cp"));
  });
});

describe("framingMessage", () => {
  test("states that the content is data and names what must not be obeyed", () => {
    const text = framingMessage({ source: "web", detail: "WebFetch" });
    assert.match(text, /UNTRUSTED CONTENT/);
    assert.match(text, /data, not instructions/);
    assert.match(text, /prompt-injection/);
    assert.ok(text.includes("WebFetch"));
  });
});

describe("evaluateUntrustedContent", () => {
  test("abstains entirely when the rail is off", () => {
    const root = newRoot();
    const decision = evaluateUntrustedContent({
      root,
      sessionKey: "s1",
      event: "mcp.after",
      config: OFF,
      providerTools: TOOLS,
    });
    assert.equal(decision.kind, "abstain");
    assert.equal(wasFramingInjected(root, "s1"), false);
  });

  test("injects context on the first untrusted read of a turn", () => {
    const root = newRoot();
    const decision = evaluateUntrustedContent({
      root,
      sessionKey: "s1",
      event: "tool.after",
      toolName: "WebFetch",
      config: ON,
      providerTools: TOOLS,
    });
    assert.equal(decision.kind, "context");
    assert.equal(wasFramingInjected(root, "s1"), true);
  });

  test("stays silent on every later read in the same turn", () => {
    const root = newRoot();
    const args = {
      root,
      sessionKey: "s1",
      event: "tool.after",
      toolName: "WebFetch",
      config: ON,
      providerTools: TOOLS,
    };
    assert.equal(evaluateUntrustedContent(args).kind, "context");
    assert.equal(evaluateUntrustedContent(args).kind, "abstain");
    assert.equal(evaluateUntrustedContent(args).kind, "abstain");
  });

  test("speaks again once the turn boundary clears the marker", () => {
    const root = newRoot();
    const args = {
      root,
      sessionKey: "s1",
      event: "tool.after",
      toolName: "WebFetch",
      config: ON,
      providerTools: TOOLS,
    };
    assert.equal(evaluateUntrustedContent(args).kind, "context");
    clearFramingMarker(root, "s1");
    assert.equal(evaluateUntrustedContent(args).kind, "context");
  });

  test("two sessions are tracked apart, so one does not mute the other", () => {
    const root = newRoot();
    const base = {
      root,
      event: "tool.after",
      toolName: "WebFetch",
      config: ON,
      providerTools: TOOLS,
    };
    assert.equal(evaluateUntrustedContent({ ...base, sessionKey: "s1" }).kind, "context");
    assert.equal(evaluateUntrustedContent({ ...base, sessionKey: "s2" }).kind, "context");
  });

  test("an ordinary read never marks the turn, so a later real one still speaks", () => {
    const root = newRoot();
    const base = { root, sessionKey: "s1", config: ON, providerTools: TOOLS };
    assert.equal(
      evaluateUntrustedContent({ ...base, event: "tool.after", toolName: "Read" }).kind,
      "abstain",
    );
    assert.equal(wasFramingInjected(root, "s1"), false);
    assert.equal(
      evaluateUntrustedContent({ ...base, event: "shell.after", command: "gh issue view 3" }).kind,
      "context",
    );
  });
});
