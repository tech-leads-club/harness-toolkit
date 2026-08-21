import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { composeProbe, probeCommands } from "../dev/verify-package.mjs";

/**
 * hazard: an independent review deleted the `tlc harness doctor` line from the probe and every test stayed green,
 * because the assertion read the script's *source* for that text — and the version check on the next line contains
 * it too. Then, with a `doctor` forced to exit 1, the release would have proceeded: the commands were joined with
 * ` && ` and ended in `|| echo`, and `&&` and `||` share precedence, so any failure fell into the `||` and the
 * compound exited 0 ([/decisions/ad-102.md](/decisions/ad-102.md)).
 */
describe("probeCommands", () => {
  const commands = probeCommands("pkg-1.0.0.tgz", "1.0.0");

  /** invariant: asserted element by element, so a deleted command cannot hide inside another one's text. */
  test("the clean room installs, then drives every command an operator would", () => {
    assert.ok(commands.includes("tlc harness version"), commands.join(" | "));
    assert.ok(commands.includes("tlc harness install"), commands.join(" | "));
    assert.ok(commands.includes("tlc harness doctor"), commands.join(" | "));
  });

  test("it installs the tarball it was given, the way npx would", () => {
    assert.equal(commands[0], "npm i -g /work/pkg-1.0.0.tgz --silent");
  });

  test("and reads the version back out of the installed runtime", () => {
    assert.ok(
      commands.some((command) => command.includes("grep -q") && command.includes("1.0.0")),
      commands.join(" | "),
    );
  });
});

/**
 * The composition rule, executed rather than read: the first failure must be the exit status, and nothing after it
 * may run.
 */
describe("composeProbe", () => {
  function shell(script: string) {
    const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "" };
  }

  test("a failure anywhere stops the run and is the exit status", () => {
    const result = shell(composeProbe(["true", "false", "echo unreachable"]));

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /unreachable/, "nothing after the failure may run");
  });

  test("a failing pipeline is a failure too, not a swallowed one", () => {
    const result = shell(composeProbe(['echo nothing | grep -q "absent"']));

    assert.notEqual(result.status, 0);
  });

  test("and a clean run is zero", () => {
    assert.equal(shell(composeProbe(["true", "echo fine"])).status, 0);
  });
});
