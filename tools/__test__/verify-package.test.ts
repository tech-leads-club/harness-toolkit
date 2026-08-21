import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
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

/**
 * hazard: this module's main flow ran at module scope, so importing it to test `probeCommands` executed `npm pack`
 * and the whole container probe. It passed locally and failed the macOS leg of CI with a file-level error at line 1
 * — the module, not a test. The rule already existed: no library module self-executes
 * ([/decisions/ad-098.md](/decisions/ad-098.md), [/decisions/ad-102.md](/decisions/ad-102.md)).
 */
test("importing the module runs nothing", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "dev", "verify-package.mjs"),
    "utf8",
  );
  const guard = source.indexOf("if (import.meta.main) {");

  assert.ok(guard > 0, "the main flow must sit behind an import.meta.main guard");
  assert.doesNotMatch(
    source.slice(0, guard),
    /^(npm|const packed|const tarball)\b/m,
    "nothing above the guard may act",
  );
});

/**
 * invariant: and the guard is asserted by behaviour too — a child process that imports the module must exit clean
 * without packing anything, which is the failure CI saw.
 */
test("a process that only imports it exits clean", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = spawnSync(
    process.execPath,
    ["-e", 'import("./tools/dev/verify-package.mjs").then(() => process.exit(0))'],
    { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}`, /payload ok|clean room/, "importing must not run the probe");
});
