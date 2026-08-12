import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeWiring, mergeClaudeSettings } from "../../src/providers/claude/claude.wiring.ts";
import { OPERATOR_OWNED, RUNTIME_PAYLOAD } from "../install-runtime.ts";
import {
  applyUninstall,
  pendingItems,
  planUninstall,
  type UninstallTargets,
  uninstallReportText,
} from "../uninstall-runtime.ts";

const LAUNCHER = "bin/tlc-exec.mjs";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tlc-uninstall-test-"));
}

/** A machine after a successful install: a runtime home, both providers wired, both links in place. */
function installedMachine(options: { linkedHome?: boolean } = {}): {
  root: string;
  targets: UninstallTargets;
  clone: string;
} {
  const root = tempRoot();
  const clone = join(root, "checkout");
  const home = options.linkedHome === true ? join(root, "home-link") : join(root, "runtime");

  const payloadRoot = options.linkedHome === true ? clone : home;
  for (const entry of RUNTIME_PAYLOAD) {
    mkdirSync(join(payloadRoot, entry), { recursive: true });
    writeFileSync(join(payloadRoot, entry, "placeholder"), "x");
  }
  mkdirSync(join(payloadRoot, "bin"), { recursive: true });
  writeFileSync(join(payloadRoot, LAUNCHER), "// launcher");
  writeFileSync(join(payloadRoot, "bin", "tlc"), "#!/usr/bin/env sh\n");
  for (const entry of OPERATOR_OWNED) {
    mkdirSync(join(payloadRoot, entry), { recursive: true });
    writeFileSync(join(payloadRoot, entry, "keepme"), "mine");
  }
  if (options.linkedHome === true) {
    symlinkSync(clone, home);
  }

  const launcherPath = join(home, LAUNCHER);
  const claudeDir = join(root, "dot-claude");
  const cursorDir = join(root, "dot-cursor");
  const binDir = join(root, "bin");
  mkdirSync(join(claudeDir, "skills"), { recursive: true });
  mkdirSync(join(cursorDir, "skills"), { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const merged = mergeClaudeSettings(
    JSON.stringify({ env: { MINE: "1" } }),
    claudeWiring({ launcherPath }).entries,
  );
  writeFileSync(join(claudeDir, "settings.json"), merged.ok ? merged.settingsText : "");
  writeFileSync(
    join(cursorDir, "hooks.json"),
    JSON.stringify({ version: 1, hooks: { stop: [{ command: `node ${launcherPath} stop` }] } }, null, 2),
  );

  const skillLinks = [join(claudeDir, "skills", "harness-init"), join(cursorDir, "skills", "harness-init")];
  mkdirSync(join(payloadRoot, "skills", "harness-init"), { recursive: true });
  for (const link of skillLinks) {
    symlinkSync(join(home, "skills", "harness-init"), link);
  }
  const binLink = join(binDir, "tlc");
  symlinkSync(join(home, "bin", "tlc"), binLink);

  return {
    root,
    clone,
    targets: {
      home,
      binLink,
      claudeSettings: join(claudeDir, "settings.json"),
      cursorHooks: join(cursorDir, "hooks.json"),
      skillLinks,
    },
  };
}

test("AC4 a symlinked runtime home is unlinked, and the checkout it pointed at keeps every file", () => {
  const { targets, clone } = installedMachine({ linkedHome: true });
  const plan = planUninstall(targets);
  assert.equal(plan.homeIsLink, true);

  const unlinked = plan.items.filter((item) => item.action === "unlink").map((item) => item.target);
  assert.equal(unlinked.includes(targets.home), true);
  // hazard: a payload entry inside a linked home reaching the plan is the data-loss bug this guards.
  assert.equal(
    plan.items.some((item) => item.target.startsWith(`${targets.home}/`) && item.action === "remove"),
    false,
  );

  applyUninstall(plan, targets);
  assert.equal(existsSync(targets.home), false);
  for (const entry of [...RUNTIME_PAYLOAD, ...OPERATOR_OWNED]) {
    assert.equal(existsSync(join(clone, entry)), true, `${entry} survived in the checkout`);
  }
  assert.equal(readFileSync(join(clone, "config.json", "keepme"), "utf8"), "mine");
});

test("AC5 without --purge the operator-owned paths are still there afterwards", () => {
  const { targets } = installedMachine();
  applyUninstall(planUninstall(targets), targets);
  for (const entry of OPERATOR_OWNED) {
    assert.equal(existsSync(join(targets.home, entry)), true, `${entry} was kept`);
  }
  assert.equal(existsSync(join(targets.home, "src")), false);
  assert.equal(existsSync(join(targets.home, "dist")), false);
});

test("AC6 with --purge the operator-owned paths are gone", () => {
  const { targets } = installedMachine();
  applyUninstall(planUninstall(targets, { purge: true }), targets);
  for (const entry of OPERATOR_OWNED) {
    assert.equal(existsSync(join(targets.home, entry)), false, `${entry} was purged`);
  }
});

test("AC7 building the plan changes nothing on disk", () => {
  const { targets } = installedMachine();
  const before = readFileSync(targets.claudeSettings, "utf8");
  const plan = planUninstall(targets);
  assert.equal(pendingItems(plan).length > 0, true);
  assert.equal(readFileSync(targets.claudeSettings, "utf8"), before);
  assert.equal(existsSync(join(targets.home, "src")), true);
  assert.equal(existsSync(targets.binLink), true);
  assert.equal(uninstallReportText(plan, null).includes("WOULD REMOVE"), true);
});

test("AC8 a second run finds nothing pending and says so", () => {
  const { targets } = installedMachine();
  applyUninstall(planUninstall(targets), targets);

  const second = planUninstall(targets);
  assert.deepEqual(pendingItems(second), []);
  assert.equal(uninstallReportText(second, null).includes("nothing to undo"), true);
});

test("AC9 a tlc on PATH that is not ours is examined and left alone", () => {
  const { targets, root } = installedMachine();
  const foreign = join(root, "somebody-elses-tlc");
  writeFileSync(foreign, "#!/bin/sh\n");
  const stranger = join(root, "bin", "tlc-other");
  symlinkSync(foreign, stranger);

  const plan = planUninstall({ ...targets, binLink: stranger });
  const item = plan.items.find((entry) => entry.target === stranger);
  assert.equal(item?.action, "keep");
  applyUninstall(plan, { ...targets, binLink: stranger });
  assert.equal(existsSync(stranger), true);
});

test("AC1/AC2 the operator's own settings survive the un-merge on a real machine layout", () => {
  const { targets } = installedMachine();
  applyUninstall(planUninstall(targets), targets);
  const settings = JSON.parse(readFileSync(targets.claudeSettings, "utf8"));
  assert.deepEqual(settings, { env: { MINE: "1" } });
});

test("a cursor hooks.json holding only our entries is removed outright", () => {
  const { targets } = installedMachine();
  applyUninstall(planUninstall(targets), targets);
  assert.equal(existsSync(targets.cursorHooks), false);
});

test("a cursor hooks.json holding a foreign entry is rewritten, not removed", () => {
  const { targets } = installedMachine();
  const launcher = join(targets.home, LAUNCHER);
  writeFileSync(
    targets.cursorHooks,
    JSON.stringify({
      version: 1,
      hooks: {
        stop: [{ command: `node ${launcher} stop` }, { command: "bash /home/me/notify.sh" }],
      },
    }),
  );
  applyUninstall(planUninstall(targets), targets);
  const document = JSON.parse(readFileSync(targets.cursorHooks, "utf8"));
  assert.deepEqual(document.hooks.stop, [{ command: "bash /home/me/notify.sh" }]);
});

test("a settings.json that does not parse is reported and never rewritten", () => {
  const { targets } = installedMachine();
  writeFileSync(targets.claudeSettings, "{ broken");
  const plan = planUninstall(targets);
  const item = plan.items.find((entry) => entry.target === targets.claudeSettings);
  assert.equal(item?.action, "keep");
  applyUninstall(plan, targets);
  assert.equal(readFileSync(targets.claudeSettings, "utf8"), "{ broken");
});

test("the per-project residue is always named, even when nothing else is left to do", () => {
  const { targets } = installedMachine();
  applyUninstall(planUninstall(targets), targets);
  const text = uninstallReportText(planUninstall(targets), null);
  assert.equal(text.includes("rm -rf .tlc/"), true);
});

test("a link left dangling by an earlier partial removal is still recognised as ours", () => {
  const { targets } = installedMachine();
  // The runtime payload goes first, which is exactly the state a run interrupted after the first rmSync leaves.
  applyUninstall(
    {
      items: [{ action: "remove", target: join(targets.home, "bin"), detail: "" }],
      purge: false,
      homeIsLink: false,
    },
    targets,
  );
  assert.equal(existsSync(targets.binLink), false, "the link now dangles");

  const plan = planUninstall(targets);
  const item = plan.items.find((entry) => entry.target === targets.binLink);
  assert.equal(item?.action, "unlink");
  applyUninstall(plan, targets);
  assert.deepEqual(pendingItems(planUninstall(targets)), []);
});

// hazard: found by running the command on the machine it was written on. A skill link left pointing at a /tmp
// install deleted weeks earlier is still residue in the operator's skills directory, and a target-based
// ownership rule leaves it there forever.
test("a skill link pointing at a runtime that no longer exists is still removed", () => {
  const { targets, root } = installedMachine();
  const dead = join(root, "deleted-install", "skills", "harness-init");
  const stale = join(root, "dot-claude", "skills", "harness-init");
  rmSync(stale);
  symlinkSync(dead, stale);

  const plan = planUninstall(targets);
  const item = plan.items.find((entry) => entry.target === stale);
  assert.equal(item?.action, "unlink");
  assert.equal(item?.detail.includes("stale"), true);

  applyUninstall(plan, targets);
  assert.equal(existsSync(stale) || lstatSync(stale, { throwIfNoEntry: false }) !== undefined, false);
});
