import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { NPM_PACKAGE, runtimePathKind } from "../bin/tlc-cli.ts";
import { findBunOnPath, writeRuntimeCache } from "../bin/tlc-exec.mjs";
import { isCursorWired } from "../bin/write-user-hooks.mjs";
import type { ProviderWiring } from "../src/contracts/index.ts";
import { coreFacade } from "../src/core/index.ts";
import { emitJson, takeJsonFlag } from "../src/platform/cli-output.ts";
import {
  projectConfigPath,
  projectStateDir,
  providerConfigDirs,
  runtimeHome,
} from "../src/platform/paths.ts";
import { catalogueMeta, planeMeta } from "../src/platform/pricing.ts";
import { type ColorName, createStyle, PLAIN, type Style, SYMBOLS } from "../src/platform/style.ts";
import { mergeClaudeSettings } from "../src/providers/claude/claude.wiring.ts";
import {
  cursorWiringProblems,
  formatWiringProblems,
  type WiringProblem,
} from "../src/providers/cursor/cursor.wiring.ts";
import { providers } from "../src/providers/index.ts";
import type { ProviderPort } from "../src/providers/provider.port.ts";

export type CheckLevel = "ok" | "warn" | "fail";

export type Check = { level: CheckLevel; name: string; detail: string };

// why: written as a person would say it. "1 warning(s)" is what a machine writes, and reading the output as the
// operator is the step that found this ([/decisions/ad-034.md](/decisions/ad-034.md)).
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const MIN_NODE = 24;

export type SpawnProbe = (command: string, args: string[]) => { ok: boolean };

/**
 * hazard: this line used to assert "hook cost ~1 ms with Bun vs ~27 ms with Node" on every machine it ran on, and had
 * measured it on none of them. An operator reported the harness as slow and the one number `doctor` offered about
 * speed was prose ([/decisions/ad-033.md](/decisions/ad-033.md)).
 *
 * why: the interpreter's cold start is the dominant term of per-hook overhead and the only part measurable without
 * side effects — every entrypoint writes something, including on an unrecognised payload. The label says which it is,
 * so the number is not read as the whole hook.
 *
 * why median: one scheduling hiccup on a loaded machine should not become the reported figure.
 */
export function medianMs(samples: readonly number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function measureRuntimeStart(args: {
  command: string;
  args: string[];
  samples?: number;
  spawn?: SpawnProbe;
  now?: () => number;
}): number | null {
  const spawn =
    args.spawn ??
    ((command: string, argv: string[]) => ({
      ok: (spawnSync(command, argv, { stdio: "ignore" }).status ?? 1) === 0,
    }));
  const now = args.now ?? (() => Date.now());
  const durations: number[] = [];
  for (let i = 0; i < (args.samples ?? 3); i += 1) {
    const started = now();
    if (!spawn(args.command, args.args).ok) {
      return null;
    }
    durations.push(now() - started);
  }
  return medianMs(durations);
}

export function checkNodeVersion(nodeVersion: string, bunPath: string | null = null): Check[] {
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "0", 10);
  const checks: Check[] = [
    {
      // why: Bun runs hooks directly, so an old Node is not a failure when Bun is present — only the
      // absence of both leaves a hook with nothing to run.
      level: nodeMajor >= MIN_NODE || bunPath !== null ? "ok" : "fail",
      name: "Node.js runtime",
      detail:
        nodeMajor >= MIN_NODE
          ? `${nodeVersion} (>= ${MIN_NODE})`
          : bunPath !== null
            ? `${nodeVersion} — below ${MIN_NODE}, covered by Bun at ${bunPath}`
            : `${nodeVersion} — no runtime for hooks. Install Bun (curl -fsSL https://bun.sh/install | bash) or Node ${MIN_NODE}+ (nodejs.org), then reload the editor.`,
    },
  ];
  if (nodeMajor === 25) {
    checks.push({
      level: "warn",
      name: "Node.js line",
      detail: "Node 25 is EOL — prefer 24 LTS or 26 Current",
    });
  }
  return checks;
}

/**
 * why: both kinds are supported installs, so both are `ok` — but a contributor whose runtime is a link to their own
 * clone needs to see that, or `update` declining to pull reads as a broken update
 * ([/decisions/ad-046.md](/decisions/ad-046.md)).
 */
export function runtimeOwnershipCheck(home: string): Check {
  const kind = runtimePathKind(home);
  const detail: Record<ReturnType<typeof runtimePathKind>, string> = {
    managed: "managed checkout — `tlc harness update` moves it to upstream and owns its contents",
    linked: "link to a working clone — update never writes here; pull that clone yourself",
    npm: "installed from npm — `tlc harness update` bumps the package and re-materialises this directory",
    unmanaged: "not a git checkout — update cannot pull; install the package and run `tlc harness install`",
    absent: "missing — install the package, then run `tlc harness install`",
  };
  return {
    level: kind === "managed" || kind === "linked" || kind === "npm" ? "ok" : "fail",
    name: "runtime ownership",
    detail: detail[kind],
  };
}

/**
 * hazard: a skill link whose destination is gone reads as installed to anything that only checks the link exists.
 * One on the machine that prompted this pointed at `/tmp/tlc-recovery-…/install/skills/harness-init` — a directory
 * from a recovery run, gone on the next boot — and nothing in the harness could see it. A provider whose skill link
 * dangles simply never routes a request to the init skill, silently
 * ([/decisions/ad-095.md](/decisions/ad-095.md)).
 *
 * invariant: reported per provider, because each reads only its own skills directory, and one being healthy says
 * nothing about the other.
 */
export function checkSkillLinks(
  home: string,
  providerDirs: readonly string[] = providerConfigDirs(),
  probe = {
    linkTarget: (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        // a dangling link cannot be realpath'd, so read the link itself before giving up
        try {
          return readlinkSync(path);
        } catch {
          return null;
        }
      }
    },
    exists: existsSync,
    // why: the runtime home is itself a symlink on a contributor install, so it has to be resolved before the
    // comparison. Without this both sides are spelled differently and every healthy link reads as foreign.
    realpath: (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
  },
): Check[] {
  return providerDirs
    .filter((dir) => existsSync(dir))
    .map((dir) => {
      const health = coreFacade.skill.linkHealth(join(dir, "skills", "harness-init"), home, probe);
      return {
        level: health.state === "ok" ? ("ok" as const) : ("fail" as const),
        name: `init skill (${basename(dir)})`,
        detail: coreFacade.skill.linkHealthMessage(health),
      };
    });
}

/**
 * How old the price catalogue on this machine is.
 *
 * hazard: nothing reported this. `docs/measure.md` claimed `doctor` "requires at least one provider catalog to be
 * present" and no such check existed, while the catalogue this repository shipped was 23 days stale across three
 * published versions. An absent catalogue is equally invisible: cost estimates simply come back null, which reads
 * the same as a turn that spent nothing ([/decisions/ad-096.md](/decisions/ad-096.md)).
 *
 * invariant: a fresh catalogue is an `ok` row that states its age and asks for nothing. A warning that fires on a
 * healthy install is not a warning ([/decisions/ad-034.md](/decisions/ad-034.md)).
 */
export function checkPrices(
  now: Date = new Date(),
  read = { meta: catalogueMeta, planes: planeMeta },
): Check[] {
  const state = coreFacade.pricing.freshness(read.meta(), now);
  const planes = read.planes();
  const named = Object.entries(planes)
    .map(([plane, meta]) => `${plane} ${meta.count ?? 0}`)
    .join(", ");
  return [
    {
      level: state.state === "fresh" ? "ok" : "warn",
      name: "prices",
      detail:
        state.state === "fresh"
          ? `${coreFacade.pricing.freshnessMessage(state, "catalogue")}${named ? ` (${named})` : ""}`
          : coreFacade.pricing.freshnessMessage(state, "catalogue"),
    },
  ];
}

/**
 * Where a shell would find the `tlc` command, if anywhere.
 *
 * hazard: this row used to pass when `~/.local/bin/tlc` existed **or** `<runtime home>/bin/tlc` existed. The
 * second is part of every install, so the check could not fail — and it printed the first path either way, so an
 * operator whose command was not on PATH read a passing row naming a file they did not have
 * ([/decisions/ad-034.md](/decisions/ad-034.md), [/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * why the four names: an npm global install writes the shims for its platform — bare on POSIX, `.cmd` and `.ps1`
 * on Windows. Trying all four everywhere costs four `existsSync` calls and needs no platform branch.
 */
export function resolveOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  exists = existsSync,
): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of [command, `${command}.cmd`, `${command}.exe`, `${command}.ps1`]) {
      const candidate = join(dir, name);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function checkRuntimePaths(home: string, platform: NodeJS.Platform): Check[] {
  const launcher = join(home, "bin", "tlc-exec.mjs");
  const distSample = join(home, "dist", "stop.mjs");
  const onPath = resolveOnPath("tlc");
  return [
    { level: "ok", name: "platform", detail: platform },
    { level: existsSync(launcher) ? "ok" : "fail", name: "global runtime", detail: home },
    runtimeOwnershipCheck(home),
    {
      level: existsSync(distSample) ? "ok" : "fail",
      name: "dist bundles",
      // why: a fixed remediation string reads as an instruction on a passing check.
      detail: existsSync(distSample) ? join(home, "dist") : "missing — run: tlc harness build",
    },
    { level: existsSync(launcher) ? "ok" : "fail", name: "portable launcher", detail: launcher },
    {
      level: onPath === null ? "fail" : "ok",
      name: "CLI on PATH",
      detail: onPath ?? `no \`tlc\` on PATH — npm i -g ${NPM_PACKAGE}, or \`npm link\` from a clone`,
    },
  ];
}

export function checkHookRuntime(
  _home: string,
  bunPath: string | null,
  measure: (args: { command: string; args: string[] }) => number | null = measureRuntimeStart,
): Check {
  const runtime = bunPath ?? process.execPath;
  const label = bunPath ? `Bun (${bunPath})` : `Node + dist/ (${process.version})`;
  const ms = measure({ command: runtime, args: ["-e", ""] });
  // why: no number rather than a guessed one. A measurement that failed is not a slow machine.
  const timing =
    ms === null
      ? " — interpreter start could not be measured on this machine"
      : ` — interpreter start measured at ${ms} ms here, paid once per hook`;
  return bunPath
    ? { level: "ok", name: "hook runtime", detail: `${label}${timing}` }
    : {
        level: "warn",
        name: "hook runtime",
        detail: `${label}${timing}. Bun runs the source directly and starts faster — install: https://bun.sh`,
      };
}

export type ProviderWiringStatus = "wired" | "detected-but-unwired" | "not-installed";

/**
 * hazard: the replace-strategy branch decided health by marker presence alone, so a file carrying the marker in one
 * entry and a broken command in another reported `wired`. A colleague's session was blocked by exactly that shape
 * ([/decisions/ad-032.md](/decisions/ad-032.md)).
 */
export function wiringProblems(wiring: ProviderWiring): WiringProblem[] {
  if (wiring.strategy !== "replace") {
    return [];
  }
  const text = existsSync(wiring.target) ? readFileSync(wiring.target, "utf8") : null;
  return cursorWiringProblems(text, { launcherPath: launcherPathOf(wiring) }, existsSync);
}

/**
 * why: derived from the wiring's own entries rather than passed in, so the check compares the file against the same
 * launcher path the writer would use. Reading it from anywhere else is how the two come to disagree.
 */
function launcherPathOf(wiring: ProviderWiring): string {
  const first = wiring.entries[0];
  return first?.args.find((arg) => arg.endsWith(".mjs")) ?? "";
}

export function providerWiringStatus(wiring: ProviderWiring): ProviderWiringStatus {
  if (!existsSync(dirname(wiring.target))) {
    return "not-installed";
  }
  if (wiring.strategy === "replace") {
    if (!isCursorWired(wiring.target)) {
      return "detected-but-unwired";
    }
    // invariant: the marker says the file is ours; the problems say whether it works. Both must pass.
    return wiringProblems(wiring).length === 0 ? "wired" : "detected-but-unwired";
  }
  const existingText = existsSync(wiring.target) ? readFileSync(wiring.target, "utf8") : null;
  const result = mergeClaudeSettings(existingText, wiring.entries);
  return result.ok && !result.changed ? "wired" : "detected-but-unwired";
}

export function checkProviders(registry: readonly ProviderPort[], home: string): Check[] {
  const launcherPath = join(home, "bin", "tlc-exec.mjs");
  return registry.map((provider) => {
    const wiring = provider.wiring({ launcherPath });
    const status = providerWiringStatus(wiring);
    if (status === "not-installed") {
      return { level: "ok", name: `${provider.name} wiring`, detail: "not installed" };
    }
    if (status === "wired") {
      return { level: "ok", name: `${provider.name} wiring`, detail: `wired (${wiring.target})` };
    }
    // why: names the event and the reason. "detected but not wired" told an operator that something was wrong and
    // nothing else, which is one step above silence.
    const problems = wiringProblems(wiring);
    const why = problems.length > 0 ? ` — ${formatWiringProblems(problems)}` : "";
    return {
      level: "warn",
      name: `${provider.name} wiring`,
      detail: `detected but not wired${why} — run: tlc harness update (${wiring.target})`,
    };
  });
}

/**
 * hazard: this returned one `warn` per capability that was not enabled, so a healthy install printed nine warnings
 * and the rows that needed attention — a diverged policy, a gate running in full — sat in the middle of them. One
 * inventory row replaces the wall; `update` still lists each one with its benefit and trade-off, which is where an
 * operator is actually choosing ([/decisions/ad-034.md](/decisions/ad-034.md)).
 */
export function checkCapabilities(root: string, runtimeRoot: string): Check[] {
  const catalog = coreFacade.capability.loadCatalog(runtimeRoot);
  const policy = coreFacade.capability.readProjectPolicyRaw(root);
  if (!catalog || !policy) {
    return [];
  }
  const available = coreFacade.capability.listAvailableNotEnabled(policy, catalog);
  if (available.length === 0) {
    return [];
  }
  return [
    {
      level: "ok",
      name: "capabilities",
      detail: coreFacade.capability.formatAvailableInventory(available),
    },
  ];
}

// why: a posture that could not be honoured is silently replaced by the default everywhere else — the loader
// applies it, the hooks obey it, and nothing in a running session says the operator's word was refused. This is
// the surface that names it, which is what makes the one-word fix findable.
function checkPosture(root: string): Check {
  const posture = coreFacade.policy.resolveProjectPosture(root);
  if (posture.origin !== "fallback") {
    return { level: "ok", name: "operator posture", detail: `${posture.mode} (from ${posture.origin})` };
  }
  return {
    level: "warn",
    name: "operator posture",
    // hazard: the remediation used to end `tlc harness mode ${posture.mode}` — the posture the fallback landed
    // on, which is the one value the operator demonstrably did not ask for. Suggesting it invites them to make
    // the substitution permanent. The command names the choice instead of guessing it.
    detail: `\`${posture.invalid}\` is not a posture — running as ${posture.mode}. Accepted: ${coreFacade.policy.OPERATOR_MODES.join(" | ")}. Fix \`mode\` in ${projectConfigPath(root)}, or run: tlc harness mode <${coreFacade.policy.OPERATOR_MODES.join("|")}>`,
  };
}

/**
 * hazard: `observe.rails` accepted any string, and a name with no checker behind it did nothing and reported
 * nothing. An operator who asked for an observation and got silence would read the silence as "the property always
 * holds" — the worst possible misreading of a measurement rail
 * ([/decisions/ad-029.md](/decisions/ad-029.md)).
 */
function checkObservedRails(root: string): Check[] {
  const policy = coreFacade.policy.loadPolicy(root);
  if (!policy.observe.enabled) {
    return [];
  }
  const unusable = coreFacade.observe.unobservableRails(policy.observe.rails);
  const observable = coreFacade.observe.OBSERVABLE_RAILS.join(" | ");
  if (policy.observe.rails.length === 0) {
    return [
      {
        level: "warn",
        name: "observed rails",
        detail: `observation is on with no rails listed, so nothing is measured. Set \`observe.rails\` to one or more of: ${observable}`,
      },
    ];
  }
  if (unusable.length === 0) {
    return [{ level: "ok", name: "observed rails", detail: policy.observe.rails.join(", ") }];
  }
  return [
    {
      level: "warn",
      name: "observed rails",
      detail: `no checker exists for ${unusable.map((rail) => `\`${rail}\``).join(", ")}, so nothing is recorded for them. Observable today: ${observable}`,
    },
  ];
}

/**
 * Reports the three states a lesson can be in that make it worth an operator's attention: withheld because its
 * refs stopped resolving, withheld because its window closed, and injected without ever being graded.
 *
 * invariant: `unproven` is a warning, not an `ok` row. A lesson nothing has tested is spending injected context
 * on an unjustified claim, and reading it as healthy is what lets a store fill with text nobody can defend
 * ([/decisions/ad-039.md](/decisions/ad-039.md)).
 *
 * why: silent when the tier is empty and when everything is healthy. A reassurance on every run is a line to skim
 * past ([/decisions/ad-034.md](/decisions/ad-034.md)).
 */
/**
 * hazard: `enforceAllowlist: true` with an empty list is a rail declared on and enforcing nothing. It used to deny
 * every spawn, which read as a bug; it now denies none, which is invisible. Neither state should be silent, and
 * this is where an operator already looks ([/decisions/ad-053.md](/decisions/ad-053.md)).
 *
 * invariant: silent when the rail is off, and silent when the list has entries. A row on a healthy install is the
 * AD-034 defect.
 */
export function checkSubagentAllowlist(root: string): Check[] {
  const { subagents } = coreFacade.policy.loadPolicy(root);
  if (!subagents.enforceAllowlist) {
    return [];
  }
  const configured = subagents.allowedModels;
  const entries = Array.isArray(configured)
    ? configured.length
    : Object.values(configured ?? {}).reduce((total, list) => total + list.length, 0);
  if (entries > 0) {
    return [];
  }
  return [
    {
      level: "fail",
      name: "subagent allowlist",
      detail:
        "enforceAllowlist is on and subagents.allowedModels is empty, so it permits every model. The harness ships no list — add the model slugs you allow, or set enforceAllowlist to false.",
    },
  ];
}

export function checkLessonHealth(root: string): Check[] {
  const policy = coreFacade.policy.loadPolicy(root);
  if (!policy.intelligence.lessons.enabled) {
    return [];
  }
  const now = new Date();
  const writable = [...coreFacade.lesson.readProjectLessons(root), ...coreFacade.lesson.readGlobalLessons()];
  if (writable.length === 0) {
    return [];
  }
  const stale = writable.filter((lesson) => coreFacade.lesson.isStaleLesson(lesson));
  const outOfWindow = writable.filter((lesson) => coreFacade.lesson.validityReason(lesson, now) !== "active");
  // why: `unproven` already means injected-and-ungraded, so a second `injectedCount > 0` test here would be the
  // same fact derived twice.
  const unproven = writable.filter((lesson) => coreFacade.lesson.lessonEffectiveness(lesson) === "unproven");
  const checks: Check[] = [];
  if (stale.length > 0) {
    checks.push({
      level: "warn",
      name: "stale lessons",
      detail: `${plural(stale.length, "lesson")} name a path or symbol that no longer resolves, so ${stale.length === 1 ? "it is" : "they are"} withheld: ${stale.map((lesson) => lesson.id).join(", ")}. Run: tlc harness lessons list`,
    });
  }
  if (outOfWindow.length > 0) {
    checks.push({
      level: "warn",
      name: "lessons out of window",
      detail: `${plural(outOfWindow.length, "lesson")} fall outside their validity window: ${outOfWindow.map((lesson) => lesson.id).join(", ")}. Run: tlc harness lessons garden`,
    });
  }
  if (unproven.length > 0) {
    checks.push({
      level: "warn",
      name: "unproven lessons",
      // hazard: this read "1 lesson have been injected … so nothing shows it help". `plural` handled the noun and
      // the verb agreement was hardcoded — the same defect as "1 warning(s)", one clause further along.
      detail:
        unproven.length === 1
          ? "1 lesson has been injected for a gate and never graded, so nothing shows it helped"
          : `${unproven.length} lessons have been injected for a gate and never graded, so nothing shows they helped`,
    });
  }
  if (checks.length === 0) {
    return [
      {
        level: "ok",
        name: "lesson health",
        detail: `${plural(writable.length, "lesson")} across the writable tiers, none stale, none out of window`,
      },
    ];
  }
  return checks;
}

/**
 * hazard: a policy divergence blocks every acting tool call in a live session, and `doctor` — the one command an
 * operator runs to find out what is wrong — said nothing about it. Measured: a colleague's agent was fully blocked,
 * ran `status`, learned nothing, and stopped ([/decisions/ad-030.md](/decisions/ad-030.md)).
 *
 * why: silent when nothing diverged. A reassurance printed on every healthy run is one more line to skim past.
 */
function checkPolicyDivergence(root: string): Check[] {
  const diverged = coreFacade.policy.allDivergedPaths(root);
  if (diverged.length === 0) {
    return [];
  }
  return [
    {
      level: "warn",
      name: "policy baseline",
      detail: `changed out of band during a live session: ${diverged.join(", ")}. If that was you: tlc harness policy accept ${diverged.join(" ")}`,
    },
  ];
}

/**
 * hazard: `appendFiles: "auto"` advertises narrowing the gate to the changed files, and for the two most common
 * command shapes it cannot deliver — a package-manager script, and a command that already carries its own glob.
 * Measured on a real install: an eslint command globbing the whole tree ran in full on every stop, three times per
 * turn, and the operator experienced it as "the harness is slow" with nothing to point at
 * ([/decisions/ad-033.md](/decisions/ad-033.md)).
 *
 * why: a warning, not a failure. Running the full suite is a legitimate choice; not knowing you are is not.
 */
function checkGateScope(root: string): Check[] {
  const policy = coreFacade.policy.loadPolicy(root);
  if (!policy.grind.enabled) {
    return [];
  }
  const checks: Check[] = [];
  for (const [label, command] of [
    ["lintCommand", policy.grind.lintCommand],
    ["testCommand", policy.grind.testCommand],
  ] as const) {
    if (!command || command.length === 0) {
      continue;
    }
    const verdict = coreFacade.gate.appendFilesVerdict(command, policy.grind.appendFiles);
    if (verdict.appends || policy.grind.appendFiles === "never") {
      continue;
    }
    checks.push({
      level: "warn",
      name: `gate scope (${label})`,
      detail: `runs in full on every attempt, up to maxLoops ${policy.grind.maxLoops}, because ${verdict.reason}. Scope the command itself, or accept the cost knowingly.`,
    });
  }
  return checks;
}

export function checkProjectPolicy(root: string): Check[] {
  const configPath = projectConfigPath(root);
  const stateDir = projectStateDir(root);
  return [
    {
      level: "ok",
      name: "project policy",
      detail: existsSync(configPath) ? configPath : "missing — run: tlc harness init",
    },
    {
      level: "ok",
      name: "state dir",
      detail: existsSync(stateDir) ? stateDir : `${stateDir} (created on first session)`,
    },
    checkPosture(root),
    ...checkObservedRails(root),
    ...checkLessonHealth(root),
    ...checkSubagentAllowlist(root),
    ...checkPolicyDivergence(root),
    ...checkGateScope(root),
  ];
}

export function checkGlobalCommands(home: string): Check {
  const globalCommands = join(home, ".cursor", "commands");
  if (!existsSync(globalCommands)) {
    return {
      level: "ok",
      name: "global commands dir",
      detail: "optional — ~/.cursor/commands for slash commands",
    };
  }
  try {
    const st = lstatSync(globalCommands);
    const detail = st.isSymbolicLink()
      ? `${globalCommands} → ${readlinkSync(globalCommands)}`
      : globalCommands;
    return { level: "ok", name: "global commands dir", detail };
  } catch {
    return { level: "ok", name: "global commands dir", detail: globalCommands };
  }
}

export type DoctorContext = {
  root: string;
  home: string;
  runtimeHome: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  bunPath: string | null;
  registry: readonly ProviderPort[];
};

export function runChecks(ctx: DoctorContext): Check[] {
  return [
    ...checkNodeVersion(ctx.nodeVersion, ctx.bunPath),
    ...checkRuntimePaths(ctx.runtimeHome, ctx.platform),
    ...checkSkillLinks(ctx.runtimeHome),
    checkHookRuntime(ctx.runtimeHome, ctx.bunPath),
    ...checkProviders(ctx.registry, ctx.runtimeHome),
    ...checkProjectPolicy(ctx.root),
    ...checkCapabilities(ctx.root, ctx.runtimeHome),
    ...checkPrices(),
    checkGlobalCommands(ctx.home),
  ];
}

export function exitCodeFor(checks: readonly Check[]): number {
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

export type CheckStatus = "OK" | "WARN" | "FAIL";

export type CheckReport = {
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
};

export type DoctorReport = {
  ok: boolean;
  failed: number;
  warned: number;
  checks: CheckReport[];
};

export function checkId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function toReport(checks: readonly Check[]): DoctorReport {
  const statuses: Record<CheckLevel, CheckStatus> = { ok: "OK", warn: "WARN", fail: "FAIL" };
  return {
    ok: exitCodeFor(checks) === 0,
    failed: checks.filter((check) => check.level === "fail").length,
    warned: checks.filter((check) => check.level === "warn").length,
    checks: checks.map((check) => ({
      id: checkId(check.name),
      name: check.name,
      status: statuses[check.level],
      detail: check.detail,
    })),
  };
}

export function formatReport(checks: readonly Check[], style: Style = PLAIN): string {
  const marks: Record<CheckLevel, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  const paint: Record<CheckLevel, ColorName> = { ok: "success", warn: "warning", fail: "error" };
  const lines = checks.map(
    (c) =>
      `${style.paint(paint[c.level], marks[c.level])}  ${style.paint("textMuted", c.name)} ${style.dim("—")} ${c.detail}`,
  );
  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  lines.push("");
  // hazard: this said "all checks passed" under twelve warnings, which is a contradiction the reader has to resolve
  // by deciding one of the two is lying ([/decisions/ad-034.md](/decisions/ad-034.md)).
  if (failed > 0) {
    lines.push(
      style.paint(
        "error",
        `${SYMBOLS.cross} doctor: ${plural(failed, "failure")}${warned > 0 ? `, ${plural(warned, "warning")}` : ""}`,
      ),
    );
  } else if (warned > 0) {
    lines.push(
      style.paint(
        "warning",
        `${SYMBOLS.warning} doctor: no failures, ${plural(warned, "warning")} to read above`,
      ),
    );
  } else {
    lines.push(style.paint("success", `${SYMBOLS.check} doctor: all checks passed`));
  }
  return lines.join("\n");
}

function realContext(): DoctorContext {
  const home = runtimeHome();
  const bunPath = findBunOnPath();
  writeRuntimeCache(home, bunPath);
  return {
    root: process.env.TLC_PROJECT_DIR ?? process.cwd(),
    home: homedir(),
    runtimeHome: home,
    platform: osPlatform(),
    nodeVersion: process.version,
    bunPath,
    registry: providers,
  };
}

if (import.meta.main) {
  const { json } = takeJsonFlag(process.argv.slice(2));
  const checks = runChecks(realContext());
  if (json) {
    emitJson(toReport(checks));
  } else {
    console.log(formatReport(checks, createStyle()));
  }
  process.exit(exitCodeFor(checks));
}
