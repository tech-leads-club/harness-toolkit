import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  coversHandler,
  decideShim,
  invocationText,
  LAUNCHER,
  type ProviderSettings,
} from "../shim.precedence.ts";

/** A user-level document shaped like the ones both hosts actually write. */
function settings(...invocations: string[]): ProviderSettings {
  return {
    hooks: Object.fromEntries(
      invocations.map((text, index) => {
        const [command = "", ...args] = text.split(" ");
        return [`Event${index}`, [{ hooks: [{ command, args }] }]];
      }),
    ),
  };
}

describe("coversHandler", () => {
  /**
   * hazard: the user-level hook runs `tlc-exec <handler>` and the project shim runs `tlc-exec shim <handler>`.
   * Comparing the two invocations for equality never matches, which is exactly why the host's own deduplication
   * ("if you define the same handler in more than one settings file, it runs once") misses them.
   */
  test("the same handler reached two ways is the same handler", () => {
    const user = settings("node /home/a/.tlc/harness/bin/tlc-exec.mjs stop");

    assert.equal(coversHandler(user, "stop"), true);
  });

  test("a different handler is not covered", () => {
    const user = settings("node /home/a/.tlc/harness/bin/tlc-exec.mjs stop");

    assert.equal(coversHandler(user, "session-start"), false);
  });

  /** invariant: a handler name that is a substring of another must not count as covered. */
  test("a handler whose name is a prefix of the registered one does not match", () => {
    const user = settings("node /x/tlc-exec.mjs subagent-stop");

    assert.equal(coversHandler(user, "stop"), false);
    assert.equal(coversHandler(user, "subagent-stop"), true);
  });

  /** invariant: somebody else's hook on the same event is not the harness. */
  test("a hook that is not the harness does not cover anything", () => {
    const user = settings("npx prettier --write stop");

    assert.equal(coversHandler(user, "stop"), false);
  });

  test("an empty or hookless document covers nothing", () => {
    assert.equal(coversHandler({}, "stop"), false);
    assert.equal(coversHandler({ hooks: {} }, "stop"), false);
    assert.equal(coversHandler({ hooks: { Stop: [{}] } }, "stop"), false);
  });

  test("it finds the handler whichever event group holds it", () => {
    const user = settings(
      "node /x/tlc-exec.mjs session-start",
      "npx prettier --write",
      "node /x/tlc-exec.mjs stop",
    );

    assert.equal(coversHandler(user, "stop"), true);
  });
});

describe("decideShim", () => {
  /**
   * why: this is the case the project shim exists for. `docs/architecture.md` — "Cloud agents without a
   * user-level install run the real handler via the shim path." Absence of user settings must mean run.
   */
  test("with no user-level settings the shim runs the handler", () => {
    const decision = decideShim(null, "stop");

    assert.equal(decision.run, true);
    assert.match(decision.reason, /only hook/);
  });

  /**
   * hazard: this is the defect. The old condition read `TLC_ACTIVE`, which nothing in the repository ever set —
   * a hook cannot export an environment variable to a later hook process — so it was never true and both levels
   * ran the handler on every overlapping event.
   */
  test("when a user-level hook already runs the handler the shim stands down", () => {
    const user = settings("node /home/a/.tlc/harness/bin/tlc-exec.mjs stop");

    const decision = decideShim(user, "stop");

    assert.equal(decision.run, false);
    assert.match(decision.reason, /already runs stop/);
  });

  test("a user-level install that does not cover this handler leaves the shim to run it", () => {
    const user = settings("node /home/a/.tlc/harness/bin/tlc-exec.mjs session-start");

    assert.equal(decideShim(user, "stop").run, true);
  });

  /** invariant: the reason is stated either way, because a shim that silently no-ops is unreadable in a log. */
  test("every decision carries a reason", () => {
    for (const [input, handler] of [
      [null, "stop"],
      [settings("node /x/tlc-exec.mjs stop"), "stop"],
      [settings("node /x/tlc-exec.mjs other"), "stop"],
    ] as [ProviderSettings | null, string][]) {
      assert.ok(decideShim(input, handler).reason.length > 0);
    }
  });
});

describe("invocationText and LAUNCHER", () => {
  test("the launcher name is what identifies the harness, not its path", () => {
    assert.equal(LAUNCHER, "tlc-exec");
    assert.equal(
      invocationText({ command: "node", args: ["/a/b/tlc-exec.mjs", "shim", "stop"] }),
      "node /a/b/tlc-exec.mjs shim stop",
    );
  });

  test("a command with no args, and an entry with neither, are both readable", () => {
    assert.equal(invocationText({ command: "node" }), "node");
    assert.equal(invocationText({}), "");
  });
});
