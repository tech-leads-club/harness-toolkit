import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProviderWiring } from "../../src/contracts/index.ts";
import { coreFacade } from "../../src/core/index.ts";
import { DEFAULTS } from "../../src/core/policy/policy.defaults.ts";
import { executableOnPath, projectConfigPath } from "../../src/platform/paths.ts";
import { mergeClaudeSettings } from "../../src/providers/claude/claude.wiring.ts";
import { cursorWiring, formatWiringProblems } from "../../src/providers/cursor/cursor.wiring.ts";
import type { ProviderPort } from "../../src/providers/provider.port.ts";
import {
  type Check,
  checkCapabilities,
  checkHookRuntime,
  checkId,
  checkNodeVersion,
  checkPrices,
  checkProjectPolicy,
  checkProviders,
  checkRules,
  checkRuntimePaths,
  checkShadowedPolicy,
  exitCodeFor,
  formatReport,
  measureRuntimeStart,
  medianMs,
  providerWiringStatus,
  runChecks,
  toReport,
  wiringProblems,
} from "../doctor.ts";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "doctor-"));
}

const cleanupRoots: string[] = [];

function newRoot(): string {
  const root = fixtureRoot();
  cleanupRoots.push(root);
  return root;
}

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("checkNodeVersion", () => {
  test("ok for a supported major", () => {
    const checks = checkNodeVersion("v24.4.0");
    assert.equal(checks[0]?.level, "ok");
  });

  test("fail for a Node major below the floor", () => {
    const checks = checkNodeVersion("v18.19.0");
    assert.equal(checks[0]?.level, "fail");
  });

  test("adds a warn for the EOL Node 25 line without failing", () => {
    const checks = checkNodeVersion("v25.0.0");
    assert.equal(checks[0]?.level, "ok");
    assert.ok(checks.some((c) => c.level === "warn" && c.name === "Node.js line"));
  });
});

describe("checkHookRuntime", () => {
  test("ok when Bun is resolved", () => {
    const check = checkHookRuntime("/opt/tlc-home", "/usr/bin/bun");
    assert.equal(check.level, "ok");
  });

  // hazard: this asserted the two hardcoded figures. They were prose on every machine, which is what made a slow
  // install undiagnosable ([/decisions/ad-033.md](/decisions/ad-033.md)).
  test("warn, never fail, and the cost is measured rather than asserted", () => {
    const check = checkHookRuntime("/opt/tlc-home", null, () => 19);
    assert.equal(check.level, "warn");
    assert.match(check.detail, /19 ms/);
    assert.doesNotMatch(check.detail, /~1 ms|~27 ms/);
  });
});

describe("providerWiringStatus", () => {
  test("not-installed when the provider home dir is absent", () => {
    const root = newRoot();
    const wiring: ProviderWiring = {
      target: join(root, "no-such-home", "hooks.json"),
      strategy: "replace",
      entries: [],
    };
    assert.equal(providerWiringStatus(wiring), "not-installed");
  });

  test("detected-but-unwired for a replace-strategy target with no harness file yet", () => {
    const root = newRoot();
    const home = join(root, "cursor-home");
    mkdirSync(home, { recursive: true });
    const wiring: ProviderWiring = { target: join(home, "hooks.json"), strategy: "replace", entries: [] };
    assert.equal(providerWiringStatus(wiring), "detected-but-unwired");
  });

  // hazard: this test used to assert that a file carrying the marker is wired, with one entry out of nineteen. That
  // was the weak rule — a colleague's session was blocked by a file that passed it. The marker still answers "is
  // this file ours"; whether the hooks work is a separate question ([/decisions/ad-032.md](/decisions/ad-032.md)).
  test("a marker with one entry out of many is detected but not wired", () => {
    const root = newRoot();
    const home = join(root, "cursor-home");
    mkdirSync(home, { recursive: true });
    const target = join(home, "hooks.json");
    writeFileSync(target, JSON.stringify({ hooks: { stop: [{ command: "node tlc-exec.mjs shim stop" }] } }));
    const wiring: ProviderWiring = { target, strategy: "replace", entries: [] };
    assert.equal(providerWiringStatus(wiring), "detected-but-unwired");
  });

  test("detected-but-unwired for a merge-strategy target missing the desired entries", () => {
    const root = newRoot();
    const home = join(root, "claude-home");
    mkdirSync(home, { recursive: true });
    const wiring: ProviderWiring = {
      target: join(home, "settings.json"),
      strategy: "merge",
      entries: [
        { hookEvent: "Stop", handler: "stop", command: "node", args: ["/x", "stop"], timeoutSeconds: 5 },
      ],
    };
    assert.equal(providerWiringStatus(wiring), "detected-but-unwired");
  });

  test("wired for a merge-strategy target already containing every desired entry", () => {
    const root = newRoot();
    const home = join(root, "claude-home");
    mkdirSync(home, { recursive: true });
    const launcher = "/x/bin/tlc-exec.mjs";
    const entries = [
      { hookEvent: "Stop", handler: "stop", command: "node", args: [launcher, "stop"], timeoutSeconds: 5 },
    ];
    const target = join(home, "settings.json");
    writeFileSync(
      target,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: [launcher, "stop"] }] }] },
      }),
    );
    assert.equal(providerWiringStatus({ target, strategy: "merge", entries }), "wired");
  });

  test("a stale harness entry from an older launcher path is replaced, not duplicated", () => {
    const root = newRoot();
    const home = join(root, "claude-home");
    mkdirSync(home, { recursive: true });
    const entries = [
      {
        hookEvent: "Stop",
        handler: "stop",
        command: "node",
        args: ["/new/bin/tlc-exec.mjs", "stop"],
        timeoutSeconds: 5,
      },
    ];
    const target = join(home, "settings.json");
    writeFileSync(
      target,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "node", args: ["/old/bin/tlc-exec.mjs", "stop"] }] },
            { hooks: [{ type: "command", command: "other-tool" }] },
          ],
        },
      }),
    );
    assert.equal(providerWiringStatus({ target, strategy: "merge", entries }), "detected-but-unwired");
    const merged = mergeClaudeSettings(readFileSync(target, "utf8"), entries);
    assert.ok(merged.ok);
    if (merged.ok) {
      const text = merged.settingsText;
      assert.equal(text.includes("/old/bin/tlc-exec.mjs"), false, "the stale entry must be gone");
      assert.ok(text.includes("/new/bin/tlc-exec.mjs"));
      assert.ok(text.includes("other-tool"), "a foreign hook must survive");
    }
  });
});

describe("checkProviders", () => {
  test("reports one check per registered provider", () => {
    const root = newRoot();
    const home = join(root, "runtime-home");
    mkdirSync(home, { recursive: true });
    const fixtureProvider = {
      name: "fixture",
      wiring: () => ({
        target: join(root, "absent-home", "x.json"),
        strategy: "replace" as const,
        entries: [],
      }),
    } as unknown as ProviderPort;
    const checks = checkProviders([fixtureProvider], home);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.name, "fixture wiring");
    assert.equal(checks[0]?.level, "ok");
    assert.match(checks[0]?.detail ?? "", /not installed/);
  });
});

describe("checkProjectPolicy", () => {
  function writeConfig(root: string, patch: Record<string, unknown>): void {
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(patch), "utf8");
  }

  test("reports the project config path whether or not it exists", () => {
    const root = newRoot();
    const checks = checkProjectPolicy(root);
    assert.equal(checks.length, 3);
    assert.ok(checks.every((c) => c.level === "ok"));
  });

  test("a valid posture is an ok row naming the posture and where it came from", () => {
    const root = newRoot();
    writeConfig(root, { version: 1, mode: "focus" });
    const row = checkProjectPolicy(root).find((c) => c.name === "operator posture");
    assert.equal(row?.level, "ok");
    assert.match(row?.detail ?? "", /focus/);
    assert.match(row?.detail ?? "", /from config/);
  });

  // hazard: a `mode` the loader cannot honour is replaced by the default with no message anywhere. The warn has
  // to quote the refused word — "invalid posture" alone leaves the operator hunting for which word it was.
  test("a value that is not a posture warns, quoting it and the accepted words", () => {
    const root = newRoot();
    writeConfig(root, { version: 1, mode: "heads-down" });
    const row = checkProjectPolicy(root).find((c) => c.name === "operator posture");
    assert.equal(row?.level, "warn");
    assert.match(row?.detail ?? "", /heads-down/);
    assert.match(row?.detail ?? "", /paired \| solo \| focus/);
    assert.match(row?.detail ?? "", /solo/);
  });

  // hazard: the remediation used to end `tlc harness mode solo` — the posture the fallback landed on, which is
  // the one value the operator demonstrably did not ask for. Read as advice it makes the substitution permanent.
  test("the remediation offers the choice instead of suggesting the fallback", () => {
    const root = newRoot();
    writeConfig(root, { version: 1, mode: "heads-down" });
    const detail = checkProjectPolicy(root).find((c) => c.name === "operator posture")?.detail ?? "";
    assert.match(detail, /tlc harness mode <paired\|solo\|focus>/);
    assert.doesNotMatch(detail, /tlc harness mode solo\b/);
  });

  // why: warn keeps doctor's exit code at 0. A bad posture is a config fault to fix, not a broken install, and
  // failing here would block the very command an operator runs to find out what is wrong.
  test("the posture warn does not fail the doctor run", () => {
    const root = newRoot();
    writeConfig(root, { version: 1, mode: "heads-down" });
    assert.equal(exitCodeFor(checkProjectPolicy(root)), 0);
  });
});

describe("exitCodeFor / formatReport", () => {
  test("exits 0 when only warn/ok checks are present", () => {
    assert.equal(
      exitCodeFor([
        { level: "ok", name: "a", detail: "" },
        { level: "warn", name: "b", detail: "" },
      ]),
      0,
    );
  });

  test("exits non-zero when any check fails", () => {
    assert.equal(
      exitCodeFor([
        { level: "ok", name: "a", detail: "" },
        { level: "fail", name: "b", detail: "" },
      ]),
      1,
    );
  });

  test("formatReport marks each level distinctly and summarizes failures", () => {
    const report = formatReport([
      { level: "ok", name: "a", detail: "fine" },
      { level: "warn", name: "b", detail: "meh" },
      { level: "fail", name: "c", detail: "broken" },
    ]);
    assert.match(report, /OK {2}.*a — fine/);
    assert.match(report, /WARN.*b — meh/);
    assert.match(report, /FAIL.*c — broken/);
    assert.match(report, /1 failure/);
  });
});

describe("toReport", () => {
  const sample: Check[] = [
    { level: "ok", name: "Node.js runtime", detail: "v24.4.0 (>= 24)" },
    { level: "warn", name: "hook runtime", detail: "Node + dist/" },
    { level: "fail", name: "dist bundles", detail: "missing — run: tlc harness build" },
  ];

  test("carries an id, a status and a detail per check", () => {
    const report = toReport(sample);
    assert.deepEqual(report.checks, [
      { id: "node-js-runtime", name: "Node.js runtime", status: "OK", detail: "v24.4.0 (>= 24)" },
      { id: "hook-runtime", name: "hook runtime", status: "WARN", detail: "Node + dist/" },
      {
        id: "dist-bundles",
        name: "dist bundles",
        status: "FAIL",
        detail: "missing — run: tlc harness build",
      },
    ]);
  });

  test("ok is false when any check fails, and the counts agree with the levels", () => {
    const report = toReport(sample);
    assert.equal(report.ok, false);
    assert.equal(report.failed, 1);
    assert.equal(report.warned, 1);
  });

  test("a warning alone leaves ok true, matching the exit code", () => {
    const warnOnly: Check[] = [{ level: "warn", name: "hook runtime", detail: "Node + dist/" }];
    const report = toReport(warnOnly);
    assert.equal(report.ok, true);
    assert.equal(report.ok, exitCodeFor(warnOnly) === 0);
  });

  test("the report survives a JSON round trip, which is the whole point of the flag", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(toReport(sample))), toReport(sample));
  });

  test("checkId slugs a name without leaving separators at either end", () => {
    assert.equal(checkId("CLI on PATH"), "cli-on-path");
    assert.equal(checkId("capability shipGate"), "capability-shipgate");
    assert.equal(checkId("Node.js runtime"), "node-js-runtime");
  });
});

describe("runChecks", () => {
  test("never mentions the legacy .cursor/harness install path", () => {
    const root = newRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const checks = runChecks({
      root,
      home,
      runtimeHome: join(root, "runtime-home"),
      platform: "linux",
      nodeVersion: "v24.4.0",
      bunPath: null,
      registry: [],
    });
    const text = formatReport(checks);
    assert.equal(text.includes(".cursor/harness"), false);
  });
});

describe("checkObservedRails", () => {
  function writeConfig(root: string, patch: Record<string, unknown>): void {
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(patch), "utf8");
  }

  test("observation off adds no row at all", () => {
    const root = newRoot();
    writeConfig(root, { version: 1 });
    assert.equal(
      checkProjectPolicy(root).some((c) => c.name === "observed rails"),
      false,
    );
  });

  test("a rail with a checker is an ok row naming it", () => {
    const root = newRoot();
    writeConfig(root, { version: 1, observe: { enabled: true, rails: ["comments"] } });
    const row = checkProjectPolicy(root).find((c) => c.name === "observed rails");
    assert.equal(row?.level, "ok");
    assert.match(row?.detail ?? "", /comments/);
  });

  // hazard: a name with no checker used to do nothing and report nothing. An operator reading that silence would
  // conclude the property always holds, which is the worst possible misreading of a measurement rail.
  test("a rail with no checker warns, quoting it and naming what is observable", () => {
    const root = newRoot();
    writeConfig(root, { version: 1, observe: { enabled: true, rails: ["plan-gate"] } });
    const row = checkProjectPolicy(root).find((c) => c.name === "observed rails");
    assert.equal(row?.level, "warn");
    assert.match(row?.detail ?? "", /plan-gate/);
    assert.match(row?.detail ?? "", /Observable today: comments/);
  });

  // why: observation on with an empty list is the shape `tlc harness init` produces if the operator says yes and
  // names nothing. Silence there is the same misreading.
  test("observation on with no rails listed warns that nothing is measured", () => {
    const root = newRoot();
    writeConfig(root, { version: 1, observe: { enabled: true, rails: [] } });
    const row = checkProjectPolicy(root).find((c) => c.name === "observed rails");
    assert.equal(row?.level, "warn");
    assert.match(row?.detail ?? "", /nothing is measured/);
  });

  test("neither warn fails the doctor run", () => {
    const root = newRoot();
    writeConfig(root, { version: 1, observe: { enabled: true, rails: ["nope"] } });
    assert.equal(exitCodeFor(checkProjectPolicy(root)), 0);
  });
});

describe("checkPolicyDivergence", () => {
  // hazard: a divergence blocks every acting tool call, and doctor — the one command an operator runs to find out
  // what is wrong — said nothing about it. A colleague's agent was fully blocked, ran `status`, learned nothing.
  test("a diverged source is reported, naming the path and the command", () => {
    const root = newRoot();
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1 }), "utf8");
    coreFacade.policy.recordPolicyBaseline(root, "s1");
    writeFileSync(path, JSON.stringify({ version: 2 }), "utf8");

    const row = checkProjectPolicy(root).find((c) => c.name === "policy baseline");
    assert.equal(row?.level, "warn");
    assert.match(row?.detail ?? "", /changed out of band/);
    assert.match(row?.detail ?? "", /tlc harness policy accept/);
  });

  // why: silent when healthy. A reassurance on every clean run is one more line to skim past.
  test("a matching baseline adds no row at all", () => {
    const root = newRoot();
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1 }), "utf8");
    coreFacade.policy.recordPolicyBaseline(root, "s1");
    assert.equal(
      checkProjectPolicy(root).some((c) => c.name === "policy baseline"),
      false,
    );
  });

  test("the warn does not fail the doctor run", () => {
    const root = newRoot();
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1 }), "utf8");
    coreFacade.policy.recordPolicyBaseline(root, "s1");
    writeFileSync(path, JSON.stringify({ version: 2 }), "utf8");
    assert.equal(exitCodeFor(checkProjectPolicy(root)), 0);
  });
});

describe("wiring health", () => {
  /** why: a realistic document — every declared event wired — so a single broken entry is what the test isolates. */
  function cursorLike(root: string, breakEvent?: string): ProviderWiring {
    const launcher = join(root, "bin", "tlc-exec.mjs");
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, "// launcher\n");
    const wiring = cursorWiring({ launcherPath: launcher });
    const hooks: Record<string, { command: string }[]> = {};
    for (const entry of wiring.entries) {
      const full = [entry.command, ...entry.args].join(" ");
      hooks[entry.hookEvent] = [
        { command: entry.hookEvent === breakEvent ? `${entry.command} ${launcher}` : full },
      ];
    }
    const home = join(root, "cursor-home");
    mkdirSync(home, { recursive: true });
    const target = join(home, "hooks.json");
    writeFileSync(target, JSON.stringify({ version: 1, hooks }));
    return { ...wiring, target };
  }

  // hazard: marker presence decided health, so a file carrying the marker in one entry and a broken command in
  // another reported `wired`. A colleague's session was blocked by exactly that shape.
  test("a file with the marker but one broken command is not wired", () => {
    const root = newRoot();
    const wiring = cursorLike(root, "preToolUse");
    assert.equal(providerWiringStatus(wiring), "detected-but-unwired");
    assert.match(formatWiringProblems(wiringProblems(wiring)), /preToolUse/);
  });

  test("a fully healthy file is still wired", () => {
    const root = newRoot();
    const wiring = cursorLike(root);
    assert.deepEqual(wiringProblems(wiring), []);
    assert.equal(providerWiringStatus(wiring), "wired");
  });

  // why: "detected but not wired" told an operator that something was wrong and nothing else.
  test("the doctor detail names the failing event and the reason", () => {
    const root = newRoot();
    const wiring = cursorLike(root, "preToolUse");
    const provider = { name: "cursor", wiring: () => wiring } as unknown as ProviderPort;
    const check = checkProviders([provider], join(root, "home"))[0];
    assert.equal(check?.level, "warn");
    assert.match(check?.detail ?? "", /preToolUse/);
    assert.match(check?.detail ?? "", /no handler after the script/);
    assert.match(check?.detail ?? "", /tlc harness update/);
  });
});

describe("measured hook cost", () => {
  // hazard: this line asserted "~1 ms with Bun vs ~27 ms with Node" on every machine and had measured it on none.
  // An operator reported the harness as slow and the one speed number doctor offered was prose.
  test("the hook runtime detail carries a measured figure, not a claim", () => {
    const check = checkHookRuntime("/opt/tlc", null, () => 42);
    assert.match(check.detail, /42 ms/);
    assert.match(check.detail, /measured/);
  });

  // why: the label names what was measured. The interpreter start is the dominant term, not the whole hook, and
  // reporting it as the whole hook would be the same overclaim in a new number.
  test("the label says it is the interpreter start, paid per hook", () => {
    const check = checkHookRuntime("/opt/tlc", "/usr/bin/bun", () => 3);
    assert.match(check.detail, /interpreter start/);
    assert.match(check.detail, /once per hook/);
  });

  test("a failed measurement reports no number rather than a guess", () => {
    const check = checkHookRuntime("/opt/tlc", null, () => null);
    assert.match(check.detail, /could not be measured/);
    assert.doesNotMatch(check.detail, /\d+ ms/);
  });

  test("Bun is still ok and Node is still a warn", () => {
    assert.equal(checkHookRuntime("/opt/tlc", "/usr/bin/bun", () => 1).level, "ok");
    assert.equal(checkHookRuntime("/opt/tlc", null, () => 30).level, "warn");
  });

  test("the median ignores one outlier rather than averaging it in", () => {
    assert.equal(medianMs([2, 3, 900]), 3);
    assert.equal(medianMs([2, 4]), 3);
    assert.equal(medianMs([]), null);
  });

  test("a spawn that fails yields no measurement", () => {
    assert.equal(measureRuntimeStart({ command: "x", args: [], spawn: () => ({ ok: false }) }), null);
  });

  test("the measurement takes the requested number of samples", () => {
    let calls = 0;
    let clock = 0;
    const ms = measureRuntimeStart({
      command: "x",
      args: [],
      samples: 3,
      spawn: () => {
        calls += 1;
        clock += 5;
        return { ok: true };
      },
      now: () => clock,
    });
    assert.equal(calls, 3);
    assert.equal(ms, 5);
  });
});

describe("gate scope", () => {
  function writeGrind(root: string, grind: Record<string, unknown>): void {
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, grind }), "utf8");
  }

  // hazard: this is the reported configuration, verbatim. An eslint command globbing the whole tree and `npm test`
  // with `appendFiles: "auto"` — both run in full on every attempt, three times per turn, and the operator
  // experienced it as "the harness is slow" with nothing to point at.
  test("the reported configuration produces a warning for each command, naming why", () => {
    const root = newRoot();
    writeGrind(root, {
      enabled: true,
      maxLoops: 3,
      appendFiles: "auto",
      lintCommand: ["npx", "eslint", "src/**/*.ts", "test/**/*.ts", "--no-fix"],
      testCommand: ["npm", "test"],
    });
    const rows = checkProjectPolicy(root).filter((c) => c.name.startsWith("gate scope"));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.level === "warn"));
    assert.match(rows.find((r) => r.name.includes("lint"))?.detail ?? "", /already scopes itself/);
    assert.match(rows.find((r) => r.name.includes("test"))?.detail ?? "", /invokes a script/);
    assert.ok(rows.every((row) => row.detail.includes("maxLoops 3")));
  });

  test("a command that does narrow produces no row", () => {
    const root = newRoot();
    writeGrind(root, { enabled: true, appendFiles: "auto", testCommand: ["npx", "jest"] });
    assert.equal(
      checkProjectPolicy(root).some((c) => c.name.startsWith("gate scope")),
      false,
    );
  });

  // why: running the full suite is a legitimate choice. `never` is the operator saying so, and saying it back to
  // them would be noise.
  test("appendFiles never is a choice, not a warning", () => {
    const root = newRoot();
    writeGrind(root, { enabled: true, appendFiles: "never", testCommand: ["npm", "test"] });
    assert.equal(
      checkProjectPolicy(root).some((c) => c.name.startsWith("gate scope")),
      false,
    );
  });

  test("grind disabled produces no row at all", () => {
    const root = newRoot();
    writeGrind(root, { enabled: false, appendFiles: "auto", testCommand: ["npm", "test"] });
    assert.equal(
      checkProjectPolicy(root).some((c) => c.name.startsWith("gate scope")),
      false,
    );
  });

  test("the warnings do not fail the doctor run", () => {
    const root = newRoot();
    writeGrind(root, { enabled: true, appendFiles: "auto", testCommand: ["npm", "test"] });
    assert.equal(exitCodeFor(checkProjectPolicy(root)), 0);
  });
});

describe("noise", () => {
  // hazard: every capability that was merely not enabled produced a warning, so a healthy install printed nine of
  // them and the rows that needed attention — a diverged policy, a gate running in full — sat in the middle. A
  // warning that fires on a healthy install teaches the reader to skip warnings, which is how the row that mattered
  // got missed ([/decisions/ad-034.md](/decisions/ad-034.md)).
  test("unenabled capabilities are one ok inventory row, never a wall of warnings", () => {
    const checks: Check[] = [
      {
        level: "ok",
        name: "capabilities",
        detail: "6 available and not enabled: a, b, c, d, e, f. Enable: …",
      },
      { level: "warn", name: "gate scope (testCommand)", detail: "runs in full" },
    ];
    const report = formatReport(checks);
    assert.equal(report.split("WARN").length - 1, 1, "exactly one warning must survive the noise");
    assert.match(report, /gate scope/);
  });

  // hazard: the summary said "all checks passed" under twelve warnings — a contradiction the reader resolves by
  // deciding one of the two is lying.
  test("the summary never claims everything passed while printing a warning", () => {
    const report = formatReport([{ level: "warn", name: "x", detail: "y" }]);
    assert.doesNotMatch(report, /all checks passed/);
    assert.match(report, /no failures, 1 warning to read/);
  });

  test("a clean run still says all checks passed", () => {
    assert.match(formatReport([{ level: "ok", name: "x", detail: "y" }]), /all checks passed/);
  });

  test("a failure is counted as a failure, and warnings alongside it are named too", () => {
    const report = formatReport([
      { level: "fail", name: "a", detail: "" },
      { level: "warn", name: "b", detail: "" },
    ]);
    assert.match(report, /1 failure, 1 warning$/m);
  });
});

// hazard: the noise test above builds its rows by hand, so it passed with the inventory row marked `warn` — a sensor
// caught it surviving. The level `checkCapabilities` chooses is the thing that decides whether a healthy install
// prints a wall ([/decisions/ad-034.md](/decisions/ad-034.md)).
test("the capability inventory row is ok, because not enabling something is not a fault", () => {
  const root = newRoot();
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "capabilities"), { recursive: true });
  writeFileSync(
    join(runtime, "capabilities", "catalog.json"),
    JSON.stringify({
      catalogVersion: 1,
      capabilities: [
        { id: "shipGate", configPath: "shipGate.enabled", title: "Ship gate", benefit: "b", tradeOff: "t" },
        { id: "observe", configPath: "observe.enabled", title: "Observation", benefit: "b", tradeOff: "t" },
      ],
    }),
  );
  const config = projectConfigPath(root);
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ version: 1 }), "utf8");

  const rows = checkCapabilities(root, runtime);
  assert.equal(rows.length, 1, "one inventory row, never one per capability");
  assert.equal(rows[0]?.level, "ok");
  assert.match(rows[0]?.detail ?? "", /2 available and not enabled/);
});

/**
 * The catalogue's age was reported nowhere, while `docs/measure.md` claimed this command checked it. An operator
 * whose prices are a month old, or absent, sees cost estimates of null — which reads exactly like a cheap turn
 * ([/decisions/ad-096.md](/decisions/ad-096.md)).
 */
describe("checkPrices", () => {
  const NOW = new Date("2026-08-19T12:00:00.000Z");
  const read = (meta: { refreshedAt?: string } | null, planes = {}) => ({
    meta: () => meta,
    planes: () => planes,
  });

  test("AC an absent catalogue is a warning that names the command", () => {
    const row = checkPrices(NOW, read(null))[0];

    assert.equal(row?.level, "warn");
    assert.match(row?.detail ?? "", /prices refresh/);
  });

  test("AC a stale catalogue is a warning that states its age", () => {
    const row = checkPrices(NOW, read({ refreshedAt: "2026-07-27T14:51:17.065Z" }))[0];

    assert.equal(row?.level, "warn");
    assert.match(row?.detail ?? "", /23 days/);
  });

  /** invariant: a healthy install asks for nothing. A warning that always fires is not a warning
   * ([/decisions/ad-034.md](/decisions/ad-034.md)). */
  test("AC a fresh catalogue is ok and asks for nothing", () => {
    const row = checkPrices(
      NOW,
      read({ refreshedAt: "2026-08-18T12:00:00.000Z" }, { cursor: { count: 47 }, litellm: { count: 1200 } }),
    )[0];

    assert.equal(row?.level, "ok");
    assert.doesNotMatch(row?.detail ?? "", /refresh/);
    assert.match(row?.detail ?? "", /cursor 47/);
    assert.match(row?.detail ?? "", /litellm 1200/);
  });

  /** why: one row, not one per plane. The operator's question is whether prices are current. */
  test("it is a single row however many planes the catalogue holds", () => {
    assert.equal(
      checkPrices(NOW, read({ refreshedAt: NOW.toISOString() }, { a: {}, b: {}, c: {} })).length,
      1,
    );
  });
});

/**
 * hazard: the "CLI on PATH" row passed when `~/.local/bin/tlc` existed **or** `<runtime home>/bin/tlc` existed.
 * The second is part of every install, so the row could not fail — and it printed the first path either way
 * ([/decisions/ad-097.md](/decisions/ad-097.md)).
 */
// why the tests moved with it: `doctor` had its own copy of the PATH walk, and it is now one function in
// `platform/` ([/decisions/ad-101.md](/decisions/ad-101.md)).
describe("executableOnPath", () => {
  const PATH = ["/a", "/b"].join(delimiter);

  test("AC5 finds the bare name a POSIX npm install writes", () => {
    const found = executableOnPath("tlc", { PATH }, (p) => p === join("/b", "tlc"));

    assert.equal(found, join("/b", "tlc"));
  });

  /** why: the `.cmd` and `.ps1` shims npm writes on Windows are found without asking which platform this is. */
  test("AC5 finds the shim names an npm install writes on Windows", () => {
    assert.equal(
      executableOnPath("tlc", { PATH }, (p) => p === join("/a", "tlc.cmd")),
      join("/a", "tlc.cmd"),
    );
    assert.equal(
      executableOnPath("tlc", { PATH }, (p) => p === join("/b", "tlc.ps1")),
      join("/b", "tlc.ps1"),
    );
  });

  test("AC5 nothing on PATH is null, not a guess", () => {
    assert.equal(
      executableOnPath("tlc", { PATH }, () => false),
      null,
    );
  });

  test("an empty PATH entry is skipped rather than probing the working directory", () => {
    const probed: string[] = [];
    executableOnPath("tlc", { PATH: `${delimiter}/a` }, (p) => {
      probed.push(String(p));
      return false;
    });

    assert.ok(
      probed.every((path) => path.startsWith(join("/a", ""))),
      probed.join(", "),
    );
  });
});

/**
 * hazard: the shipped `config.example.json` turned `subagents.enforceAllowlist` on and shipped no list — which is
 * the exact combination [/decisions/ad-053.md](/decisions/ad-053.md) exists to refuse, and `install` copies that
 * file to the runtime home. Every fresh install's first `doctor` therefore printed a red FAIL the operator did
 * nothing to cause ([/decisions/ad-034.md](/decisions/ad-034.md), [/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * invariant: the config this product ships must produce no failure on the machine it is shipped to.
 */
test("AC the shipped config raises no fault on a fresh install", () => {
  const shipped = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config.example.json"), "utf8"),
  ) as { subagents?: { enforceAllowlist?: boolean; allowedModels?: unknown } };

  assert.equal(
    shipped.subagents?.enforceAllowlist === true && shipped.subagents?.allowedModels === undefined,
    false,
    "enforceAllowlist with no allowedModels is a rail declared on and enforcing nothing",
  );
});

/**
 * AC14 — two tiers apply together, so "why did this fire?" and "why did it not?" are both answered by knowing
 * which tier a rule came from ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
describe("checkRules", () => {
  function project(rules: Record<string, string>, enabled = true): string {
    const root = newRoot();
    const config = projectConfigPath(root);
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ version: 1, rules: { enabled } }), "utf8");
    const dir = join(root, ".tlc", "harness", "rules");
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(rules)) {
      writeFileSync(join(dir, `${name}.md`), text, "utf8");
    }
    return root;
  }

  const VALID = `---\non: pr-open\nrequire:\n  - subagent(the-jury) since HEAD\notherwise: deny\n---\nConvene the jury.`;

  /** invariant: silent when nobody opted in ([/decisions/ad-034.md](/decisions/ad-034.md)). */
  test("AC1 nothing is reported when the capability is off", () => {
    assert.deepEqual(checkRules(project({ "review-before-pr": VALID }, false)), []);
  });

  /**
   * hazard: this test used to assert silence here, which is what the defect looked like from the consumer side.
   * Switched on with no rule file the mechanism is inert, and every other report about it is empty too — so
   * silence is indistinguishable from a working install for the one person who opted in
   * ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  test("AC1 the capability on with no rule file says so, and names both directories", () => {
    const root = project({});
    const rows = checkRules(root);
    const row = rows.find((entry) => entry.name === "operator rules");

    assert.equal(row?.level, "warn");
    assert.match(row?.detail ?? "", /no rule file was found/);
    assert.ok(row?.detail.includes(join(root, ".tlc", "harness", "rules")), "the project directory is named");
    assert.ok(row?.detail.includes(coreFacade.rules.globalDir()), "the machine directory is named");
  });

  test("AC14 an active rule is listed with its tier, trigger and verdict", () => {
    const rows = checkRules(project({ "review-before-pr": VALID }));
    const listed = rows.find((row) => row.name === "operator rules");

    assert.equal(listed?.level, "ok");
    assert.match(listed?.detail ?? "", /review-before-pr \(project\) on pr-open → deny/);
  });

  test("AC10 a malformed rule fails by name and says the others still apply", () => {
    const rows = checkRules(project({ broken: "no frontmatter here", "review-before-pr": VALID }));
    const failure = rows.find((row) => row.level === "fail");

    assert.match(failure?.name ?? "", /broken/);
    assert.match(failure?.detail ?? "", /the other rules still apply/);
    assert.ok(
      rows.some((row) => row.name === "operator rules"),
      "and the valid one is still listed",
    );
  });

  test("AC12 a rule switched off here is reported as such, not hidden", () => {
    const off = `---\non: pr-open\nenabled: false\notherwise: deny\n---\nInfra repo: reviewed in the PR.`;
    const rows = checkRules(project({ "review-before-pr": off }));

    assert.ok(rows.some((row) => row.name === "operator rules (off here)"));
  });

  /** AC11 — factual, not a guess about the host: this kind has never been recorded here. */
  test("AC11 a rule needing a kind never observed here is a warning that names both", () => {
    const rows = checkRules(project({ "review-before-pr": VALID }));
    const warning = rows.find((row) => row.level === "warn");

    assert.match(warning?.name ?? "", /review-before-pr/);
    assert.match(warning?.detail ?? "", /needs subagent/);
    assert.match(warning?.detail ?? "", /no observation of that kind/);
  });
});

/**
 * hazard: `init` writes the whole default policy when there is no config yet, and the wizard writes every knob it
 * collected — so a project config typically names dozens of values it did not choose, each shadowing the
 * machine-wide tier for ever. Measured on this repository the day it was added: 29 keys
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
describe("checkShadowedPolicy", () => {
  function projectWith(config: Record<string, unknown>, user: Record<string, unknown> = {}): string {
    const root = newRoot();
    const home = newRoot();
    process.env.TLC_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify(user), "utf8");
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config), "utf8");
    return root;
  }

  test("no project config is nothing to report", () => {
    assert.deepEqual(checkShadowedPolicy(newRoot()), []);
  });

  test("a project that only decides things is silent", () => {
    const root = projectWith({ version: 1, mode: "focus" }, { mode: "solo" });

    assert.deepEqual(checkShadowedPolicy(root), []);
  });

  test("a key restating the user tier is a warning that names the path and the file", () => {
    const root = projectWith(
      { version: 1, intelligence: { lessons: { maxCharsSession: 3000 } } },
      { intelligence: { lessons: { maxCharsSession: 3000 } } },
    );

    const row = checkShadowedPolicy(root)[0];

    assert.equal(row?.level, "warn");
    assert.match(row?.detail ?? "", /intelligence\.lessons\.maxCharsSession/);
    assert.match(row?.detail ?? "", /config\.json/);
    assert.match(row?.detail ?? "", /machine-wide change will not reach this repository/);
  });

  test("a key restating a shipped default is reported too, with no user config at all", () => {
    const root = projectWith({ version: 1, mode: DEFAULTS.mode });

    assert.match(checkShadowedPolicy(root)[0]?.detail ?? "", /mode/);
  });

  /** invariant: the list is bounded and says how many it did not print, rather than trailing off. */
  test("more than six restated keys are counted rather than dumped", () => {
    const block = {
      enabled: false,
      emptyDiffAntiShip: false,
      evidenceMaxAgeHours: DEFAULTS.shipGate.evidenceMaxAgeHours,
      claimWindowMinutes: DEFAULTS.shipGate.claimWindowMinutes,
    };
    const root = projectWith({
      version: 1,
      mode: DEFAULTS.mode,
      shipGate: block,
      comments: { enabled: false, mode: DEFAULTS.comments.mode, onViolation: DEFAULTS.comments.onViolation },
    });

    const detail = checkShadowedPolicy(root)[0]?.detail ?? "";

    assert.match(detail, /and \d+ more/);
    // why the substring and not a split of the whole sentence: the closing prose contains dots too
    // ("config.json", "repository."), so counting them over-reported and the first version of this
    // assertion failed on correct output.
    const listed = /have: (.+?), and \d+ more\./.exec(detail)?.[1] ?? "";
    assert.equal(listed.split(", ").length, 6, listed);
  });
});

/**
 * hazard: `doctor` printed twenty rows and not one carried a version, so an operator could not answer "which
 * version am I running" from any command ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
describe("the version row", () => {
  test("names the version read from the runtime's own manifest", () => {
    const home = newRoot();
    writeFileSync(join(home, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8");

    const row = checkRuntimePaths(home, "linux").find((check) => check.name === "harness version");

    assert.equal(row?.level, "ok");
    assert.equal(row?.detail, "9.9.9");
  });

  /** invariant: a runtime with no readable manifest is a warning, not a missing row. */
  test("an unreadable manifest is reported rather than omitted", () => {
    const row = checkRuntimePaths(newRoot(), "linux").find((check) => check.name === "harness version");

    assert.equal(row?.level, "warn");
    assert.match(row?.detail ?? "", /unknown/);
  });
});
