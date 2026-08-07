import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { coreFacade } from "../src/core/index.ts";
import { emitJson, JSON_FLAG, takeJsonFlag, unknownFlags } from "../src/platform/cli-output.ts";
import { flagsDir, projectConfigPath, projectStateDir, runtimeHome } from "../src/platform/paths.ts";

export class UsageError extends Error {}

// why: derived from the facade rather than imported from inside the policy aggregate, so the CLI keeps its
// single door into core and the two cannot drift apart.
type Posture = ReturnType<typeof coreFacade.policy.resolveProjectPosture>;

export function resolveProjectRoot(): string {
  return process.env.TLC_PROJECT_DIR ?? process.cwd();
}

export function modeFilePath(root: string): string {
  return join(projectStateDir(root), "harness-mode");
}

export function grindFlagPath(root: string): string {
  return join(flagsDir(root), "grind-on");
}

export function skipFlagPath(root: string): string {
  return join(flagsDir(root), "skip-verify");
}

// why: the posture flag files carry the posture names, so there is one spelling per posture across the config
// field, the state file, the flag file and this command.
export function focusFlagPath(root: string): string {
  return join(flagsDir(root), "focus");
}

export function pairedFlagPath(root: string): string {
  return join(flagsDir(root), "paired");
}

export function ensureFlagsDir(root: string): void {
  mkdirSync(flagsDir(root), { recursive: true });
}

export function readMode(root: string): string {
  return coreFacade.policy.loadPolicy(root).mode;
}

export function grindOn(root: string): boolean {
  return coreFacade.policy.loadPolicy(root).grind.enabled;
}

export function gatesPaused(root: string): boolean {
  return existsSync(skipFlagPath(root));
}

export function acceptedModes(): string {
  return coreFacade.policy.OPERATOR_MODES.join(" | ");
}

export function statusText(root: string): string {
  const report = statusJson(root);
  // why: a rejected value is reported next to the posture that replaced it. Printing only `fallback` would
  // leave the operator with a posture they did not set and no way to see which word was refused.
  const origin =
    report.modeInvalid === undefined
      ? `from ${report.modeOrigin}`
      : `${report.modeOrigin} — \`${report.modeInvalid}\` is not a posture; accepted: ${acceptedModes()}`;
  return [
    `harness @ ${root}`,
    `  mode:   ${report.mode} [${origin}]`,
    `  grind:  ${report.grind ? "ON  — stop hook re-runs lint/tests and auto-retries on fail" : "OFF — no auto fix loops"}`,
    `  gates:  ${report.gatesPaused ? "PAUSED — stop checks disabled" : "active"}`,
    "",
    "Quick help:",
    "  grind ON  = after each agent turn, lint/test changed files; if fail → agent must fix",
    "  pause     = temporarily disable those stop checks",
    "  posture   = how much the agent surfaces. Verification is identical at all three.",
    "  paired    = explains as it goes, and asks before any sizable move",
    "  solo      = works on its own; a destructive action, a dead-end or real ambiguity reaches you",
    "  focus     = only a destructive action or a dead-end reaches you; it settles ambiguity itself",
  ].join("\n");
}

export type StatusReport = {
  root: string;
  mode: string;
  modeOrigin: Posture["origin"];
  modeInvalid?: string;
  grind: boolean;
  gatesPaused: boolean;
};

export function statusJson(root: string): StatusReport {
  const policy = coreFacade.policy.loadPolicy(root);
  // invariant: posture and its origin come from the resolver the loader itself uses. Status recomputing either
  // one is what made it report the opposite of every hook (AD-020).
  const posture = coreFacade.policy.resolveProjectPosture(root);
  return {
    root,
    mode: posture.mode,
    modeOrigin: posture.origin,
    ...(posture.invalid === undefined ? {} : { modeInvalid: posture.invalid }),
    grind: policy.grind.enabled,
    gatesPaused: gatesPaused(root),
  };
}

// invariant: every sanctioned mutation re-records the baselines. That is what makes "a harness command did
// this" and "the baseline matches" a single fact — an out-of-band write skips this call and stays visible.
export function setGrind(root: string, on: boolean): string {
  ensureFlagsDir(root);
  const path = grindFlagPath(root);
  if (on) {
    writeFileSync(path, "");
    coreFacade.policy.refreshPolicyBaselines(root);
    return "grind ON — stop hook will lint/test and auto-retry on failure";
  }
  if (existsSync(path)) {
    rmSync(path);
  }
  coreFacade.policy.refreshPolicyBaselines(root);
  return "grind OFF — no auto fix loops";
}

export function setPaused(root: string, on: boolean): string {
  ensureFlagsDir(root);
  const path = skipFlagPath(root);
  if (on) {
    writeFileSync(path, "");
    coreFacade.policy.refreshPolicyBaselines(root);
    return "gates PAUSED — stop checks disabled until `tlc harness resume`";
  }
  if (existsSync(path)) {
    rmSync(path);
  }
  coreFacade.policy.refreshPolicyBaselines(root);
  return "gates ACTIVE again";
}

// hazard: this used to map `focus` onto a second spelling before writing, so the word the operator typed and the
// word the config field stored were different — and a config written from the documented word then matched no
// branch at all. One word per posture, and nothing translates.
const MODE_CONFIRMATION: Record<Posture["mode"], string> = {
  paired: "mode paired — explains as it goes, and asks before any sizable move",
  solo: "mode solo — a destructive action, a dead-end or real ambiguity reaches you",
  focus: "mode focus — only a destructive action or a dead-end reaches you; ambiguity is settled for you",
};

export function setMode(root: string, raw: string): string {
  const mode = raw.toLowerCase();
  if (!coreFacade.policy.isOperatorMode(mode)) {
    throw new UsageError(`mode must be: ${acceptedModes()}`);
  }
  ensureFlagsDir(root);
  writeFileSync(modeFilePath(root), `${mode}\n`);
  coreFacade.policy.refreshPolicyBaselines(root);
  // why: posture governs surfacing only. Announcing grind here would claim a capability this command does not
  // touch — it has its own switch, its own flag and its own trade-off.
  return MODE_CONFIRMATION[mode];
}

export type HandoffReport = {
  root: string;
  providers: Record<string, ReturnType<typeof coreFacade.handoff.readHandoff>>;
};

/**
 * The sanctioned way to read handoff state.
 *
 * why: the bootstrap used to tell the agent to read `.tlc/harness/state/handoff.json`, a path the floor guards. So
 * the instruction and the permission disagreed, and the obvious command — `test -f … && head -c 2000 …` — was
 * refused with advice about writing policy. An instruction is not an affordance; the route the harness asks for has
 * to be one it grants ([/decisions/ad-047.md](/decisions/ad-047.md)).
 */
export function handoffJson(root: string): HandoffReport {
  const file = coreFacade.handoff.readHandoffFile(root);
  const providers: HandoffReport["providers"] = {};
  for (const provider of Object.keys(file.by_provider)) {
    providers[provider] = coreFacade.handoff.readHandoff(root, provider);
  }
  return { root, providers };
}

export function handoffText(report: HandoffReport): string {
  const names = Object.keys(report.providers);
  if (names.length === 0) {
    return `handoff @ ${report.root}\n  nothing recorded yet — this is a fresh start, not a missing file`;
  }
  const lines = [`handoff @ ${report.root}`];
  for (const name of names.sort()) {
    const slice = report.providers[name];
    if (!slice) {
      continue;
    }
    lines.push(`  ${name} (updated ${slice.updated_at})`);
    for (const [label, value] of [
      ["blockers", slice.blockers],
      ["next", slice.next_action],
      ["last gate", slice.last_gate_result],
      ["last failure", slice.last_failure_category],
    ] as const) {
      if (value) {
        lines.push(`    ${label}: ${value}`);
      }
    }
    for (const [label, list] of [
      ["in progress", slice.in_progress],
      ["pending", slice.pending],
      ["gaps", slice.previous_gaps?.map((gap) => gap.summary)],
    ] as const) {
      if (list && list.length > 0) {
        lines.push(`    ${label}: ${list.slice(0, 6).join(" | ")}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * why: the artifact a reviewer can read. Everything in it is something the harness observed, and the chain is what
 * makes a rewritten middle detectable ([/decisions/ad-028.md](/decisions/ad-028.md)).
 */
export function attestText(root: string): string {
  const records = coreFacade.attest.readAttestations(root);
  const verdict = coreFacade.attest.verifyChain(records);
  const head = verdict.ok
    ? `attestation chain OK — ${verdict.length} session(s)`
    : `attestation chain BROKEN at record ${verdict.brokenAt} (${verdict.reason})`;
  if (records.length === 0) {
    return `${head}\n  no sessions recorded yet`;
  }
  const rows = records.slice(-10).map((record) => {
    const rules = Object.entries(record.decisionsByRule)
      .map(([rule, count]) => `${rule}=${count}`)
      .join(" ");
    return [
      `  ${record.ts}  ${record.provider}/${record.session}`,
      `    policy ${record.policyFingerprint}${record.policyDiverged ? " (DIVERGED mid-session)" : ""}`,
      `    rails  ${record.railsActive.join(", ") || "none"}`,
      `    gates  ${record.gates.pass} pass / ${record.gates.fail} fail${rules ? `  |  ${rules}` : ""}`,
    ].join("\n");
  });
  return [head, ...rows].join("\n");
}

export type AttestReport = {
  ok: boolean;
  brokenAt?: number;
  reason?: string;
  sessions: number;
  records: ReturnType<typeof coreFacade.attest.readAttestations>;
};

export function attestJson(root: string): AttestReport {
  const records = coreFacade.attest.readAttestations(root);
  const verdict = coreFacade.attest.verifyChain(records);
  return verdict.ok
    ? { ok: true, sessions: verdict.length, records }
    : { ok: false, brokenAt: verdict.brokenAt, reason: verdict.reason, sessions: records.length, records };
}

/**
 * The one command whose job is to clear a tampering signal, which is why four independent locks sit between it and
 * an agent ([/decisions/ad-030.md](/decisions/ad-030.md)):
 *
 * 1. the floor refuses `tlc harness policy` from inside any agent session, with no config switch;
 * 2. this refuses without an interactive terminal, so a script cannot reach it either;
 * 3. the operator names each path, so accepting is an act rather than a keystroke and its blast radius is exactly
 *    what was typed;
 * 4. acceptance is per source, so the other divergences keep blocking.
 *
 * hazard: `interactive` is a parameter rather than an `isTTY` read, so the refusal is testable without a pty. That
 * matters most on the rail whose failure mode is silence.
 */
export function acceptPolicy(root: string, paths: string[], interactive: boolean): string {
  if (!interactive) {
    throw new UsageError(
      "tlc harness policy accept needs an interactive terminal — clearing a policy divergence is the operator's call, not a script's.",
    );
  }
  if (paths.length === 0) {
    throw new UsageError(
      "usage: tlc harness policy accept <path> [path...]  (run `tlc harness policy` to list)",
    );
  }
  const outcome = coreFacade.policy.acceptPolicySources(root, paths);
  if (outcome.kind === "not-a-source") {
    throw new UsageError(
      [
        `not a policy source: ${outcome.paths.join(", ")}`,
        "The sources the loader reads are:",
        ...outcome.sources.map((source) => `  ${source}`),
      ].join("\n"),
    );
  }
  if (outcome.kind === "nothing-to-accept") {
    return "nothing to accept — no session has recorded a baseline yet";
  }
  return `accepted: ${outcome.paths.join(", ")}\n  every live session now treats these as the policy the operator set`;
}

export function policyText(root: string): string {
  const diverged = coreFacade.policy.allDivergedPaths(root);
  if (diverged.length === 0) {
    return "policy baseline matches — nothing changed out of band during any live session";
  }
  return [
    `policy changed out of band during a live session (${diverged.length}):`,
    ...diverged.map((path) => `  ${path}`),
    "",
    "If that was you, accept it from your own terminal with:",
    `  tlc harness policy accept ${diverged.join(" ")}`,
    "",
    "Accepting is per path, so anything you leave out keeps blocking.",
  ].join("\n");
}

export type PolicyReport = { diverged: string[]; ok: boolean };

export function policyJson(root: string): PolicyReport {
  const diverged = coreFacade.policy.allDivergedPaths(root);
  return { diverged, ok: diverged.length === 0 };
}

/** why: computed once and read by both `update` and `update --check`, so the two cannot disagree about what is upstream. */
export function upstreamRef(dest: string): string {
  const read = (args: string[]): string => {
    const r = spawnSync("git", ["-C", dest, ...args], { encoding: "utf8", env: process.env });
    return (r.status ?? 1) === 0 ? (r.stdout ?? "").trim() : "";
  };
  const tracked = read(["rev-parse", "--abbrev-ref", "@{u}"]);
  if (tracked !== "") {
    return tracked;
  }
  return `origin/${read(["rev-parse", "--abbrev-ref", "HEAD"]) || "main"}`;
}

/**
 * What kind of runtime path this is, which decides what `update` may write to it.
 *
 * The distinction is the whole fix. A `managed` path is an artifact the installer created and the harness owns, so
 * a conflict in it is not a decision for the operator — it is discarded. A `linked` path is a symlink to somebody's
 * working clone, so nothing there may be written by a harness command at all
 * ([/decisions/ad-046.md](/decisions/ad-046.md)).
 */
export type RuntimePathKind = "managed" | "linked" | "npm" | "unmanaged" | "absent";

export const NPM_PACKAGE = "@tech-leads-club/harness-toolkit";

/**
 * why: an npm-delivered runtime is a real directory with no `.git`, which the old classifier called `unmanaged`
 * and `doctor` reported as a failure — on a perfectly healthy install. It is told apart by the marker the
 * installer leaves, not by guessing from the contents, because a directory can be many things and only the thing
 * that created it knows which ([/decisions/ad-056.md](/decisions/ad-056.md)).
 */
export const NPM_MARKER = "installed-from-npm";

/**
 * hazard: `install.sh` links the runtime path to the clone it was run from, so on a contributor's machine
 * `~/.tlc/harness` is a symlink to their working repository. The old failure message told them to run
 * `git reset --hard` there, which would have destroyed uncommitted work. Verified on this machine.
 *
 * invariant: the symlink test comes first and is decided by the path, never by its contents. A linked clone
 * contains a `.git` too, so testing for that first would classify it as ours.
 */
export function classifyRuntimePath(
  dest: string,
  probe: { isSymlink: (path: string) => boolean; exists: (path: string) => boolean },
): RuntimePathKind {
  if (probe.isSymlink(dest)) {
    return "linked";
  }
  if (!probe.exists(dest)) {
    return "absent";
  }
  if (probe.exists(join(dest, ".git"))) {
    return "managed";
  }
  return probe.exists(join(dest, NPM_MARKER)) ? "npm" : "unmanaged";
}

/**
 * hazard: this must be asked about the **configured** home, not a resolved one. `resolveHarnessRoot` calls
 * `realpathSync`, so passing its result made a linked clone look like a managed checkout — and `update` then ran
 * `git fetch` inside a contributor's repository. Caught by driving the real command against a linked install rather
 * than by any unit test ([/decisions/ad-046.md](/decisions/ad-046.md)).
 *
 * hazard: an earlier version also treated "resolves elsewhere" as linked, to catch a symlinked ancestor. macOS CI
 * refuted it: `/var` is a symlink to `/private/var`, so every path under the system temp directory resolves
 * elsewhere and a **managed** checkout was classified as linked — which would silently stop updates on the very
 * platform the reporter uses. Only the last hop decides, which is the one thing `install.sh` actually creates.
 */
export function runtimePathKind(dest: string): RuntimePathKind {
  return classifyRuntimePath(dest, {
    isSymlink: (path) => {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    },
    exists: existsSync,
  });
}

/**
 * The bundles an install needs but does not have.
 *
 * why: derived from the entrypoints on disk, the same way `bin/tlc-build` derives them. A fixed list would stop
 * naming a new entrypoint and the missing bundle would only surface when a hook fired.
 */
export function missingBundles(dest: string): string[] {
  const entrypoints = join(dest, "src", "entrypoints");
  if (!existsSync(entrypoints)) {
    return [];
  }
  const expected = readdirSync(entrypoints)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `${name.slice(0, -3)}.mjs`);
  return expected.filter((bundle) => !existsSync(join(dest, "dist", bundle)));
}

/**
 * hazard: `dest` was accepted and never used, so the message said "the runtime path" without naming it while both
 * sibling messages name theirs. An operator with more than one runtime could not tell which link was meant.
 */
export function linkedRuntimeMessage(dest: string, target: string | null): string {
  return [
    `update: ${dest} is a link to a working clone${target ? ` → ${target}` : ""}.`,
    "Nothing in it is touched by this command — updating that clone is your own `git pull`.",
    "Refreshing the machine-local parts only: CLI link, init skill, provider hooks.",
  ].join("\n");
}

/**
 * hazard: this printed `update: git fetch failed.` and stopped. Against a private repository the cause is almost
 * always a missing GitHub credential, and git's own error does not mention org membership or `gh` — the same shape
 * as the refusal AD-047 was written about ([/decisions/ad-052.md](/decisions/ad-052.md)).
 */
export function fetchFailureMessage(dest: string): string {
  return [
    `update: git fetch failed in ${dest}.`,
    "  If the repository is private, this needs a GitHub credential: `gh auth login`, then `gh auth setup-git`,",
    "  and membership of the org that owns it.",
    "  If this runtime predates the move to tech-leads-club/harness-toolkit, it is still pointing at the old",
    "  repository — re-run the installer from the README to move it.",
  ].join("\n");
}

export function unmanagedRuntimeMessage(dest: string): string {
  return [
    `update: ${dest} is not a git checkout, so there is nothing to pull.`,
    "Re-install with the curl/irm one-liner from the README to get a managed runtime.",
  ].join("\n");
}

/**
 * hazard: the git route's bare `update: git fetch failed.` sent an operator to the wrong problem for a week. A
 * failing global install has its own small set of causes and each has a different fix, so they are named.
 */
export function npmUpdateFailureMessage(): string {
  return [
    `update: npm could not install ${NPM_PACKAGE}@latest.`,
    "  permissions — a global prefix owned by root needs sudo, or an npm prefix you own:",
    "                npm config set prefix ~/.local",
    "  not found    — the package is published; check the network and any registry proxy in ~/.npmrc",
    "  offline      — nothing was changed; the runtime you have still works.",
  ].join("\n");
}

export function resetFailureMessage(dest: string, mergeRef: string, gitOutput: string): string {
  return [
    `update: could not move the runtime to ${mergeRef}.`,
    `  path: ${dest} (managed checkout)`,
    gitOutput.trim() ? `  git: ${gitOutput.trim().split("\n").slice(-3).join(" / ")}` : "",
    "Nothing was changed. Re-install with the one-liner from the README if this persists.",
  ]
    .filter(Boolean)
    .join("\n");
}

export type RuntimeRevision = { revision: string | null; date: string | null };

/**
 * why: the revision is what `update` already moves, so it cannot drift the way a hand-edited version number does.
 * `package.json` has said `0.1.0` since the first commit, which is the failure mode a number invites. And a semantic
 * version is a promise about compatibility that AD-003 refuses to make ([/decisions/ad-031.md](/decisions/ad-031.md)).
 */
export function runtimeRevision(dest: string): RuntimeRevision {
  if (!existsSync(join(dest, ".git"))) {
    return { revision: null, date: null };
  }
  const read = (args: string[]): string | null => {
    const r = spawnSync("git", ["-C", dest, ...args], { encoding: "utf8", env: process.env });
    const out = (r.stdout ?? "").trim();
    return (r.status ?? 1) === 0 && out !== "" ? out : null;
  };
  return { revision: read(["rev-parse", "--short", "HEAD"]), date: read(["log", "-1", "--format=%cs"]) };
}

export type VersionReport = {
  runtime: string;
  revision: string | null;
  date: string | null;
  seenRevision: string | null;
};

export function versionJson(root: string): VersionReport {
  const dest = resolveHarnessRoot();
  const { revision, date } = runtimeRevision(dest);
  return {
    runtime: dest,
    revision,
    date,
    seenRevision: coreFacade.release.readReleaseSeen(root)?.revision ?? null,
  };
}

export function versionText(root: string): string {
  const report = versionJson(root);
  if (report.revision === null) {
    // why: says so rather than printing an empty revision. A linked checkout with no `.git` is a real install shape.
    return [
      `harness runtime: ${report.runtime}`,
      "  revision: unknown — the runtime path is not a git checkout, so `update` cannot pull either",
    ].join("\n");
  }
  return [
    `harness runtime: ${report.runtime}`,
    `  revision: ${report.revision} (${report.date ?? "date unknown"})`,
    `  this project last saw: ${report.seenRevision ?? "nothing yet — the next update will announce what landed"}`,
  ].join("\n");
}

export type PendingReport = {
  ok: boolean;
  reason?: string;
  commits: number;
  decisions: ReturnType<typeof coreFacade.release.readDecisions>;
};

/**
 * why: fetches and never merges. "Look before you leap" that changes something is just leaping, so the merge is not
 * reachable from this path at all rather than guarded by a flag.
 */
export function pendingUpdate(dest: string, mergeRef: string): PendingReport {
  if (!existsSync(join(dest, ".git"))) {
    return { ok: false, reason: "the runtime path is not a git checkout", commits: 0, decisions: [] };
  }
  const fetch = spawnSync("git", ["-C", dest, "fetch", "origin"], { stdio: "inherit", env: process.env });
  if ((fetch.status ?? 1) !== 0) {
    return { ok: false, reason: "git fetch failed", commits: 0, decisions: [] };
  }
  const count = spawnSync("git", ["-C", dest, "rev-list", "--count", `HEAD..${mergeRef}`], {
    encoding: "utf8",
    env: process.env,
  });
  const commits = Number.parseInt((count.stdout ?? "0").trim(), 10) || 0;
  const added = spawnSync(
    "git",
    ["-C", dest, "diff", "--name-only", "--diff-filter=A", `HEAD..${mergeRef}`, "--", "docs/decisions"],
    { encoding: "utf8", env: process.env },
  );
  const files = (added.stdout ?? "")
    .split("\n")
    .map((line) => line.trim().split("/").pop() ?? "")
    .filter(Boolean);
  return { ok: true, commits, decisions: coreFacade.release.readDecisions(dest, files) };
}

export function pendingText(report: PendingReport): string {
  if (!report.ok) {
    return `update --check: ${report.reason} — nothing to compare against`;
  }
  if (report.commits === 0) {
    return "update --check: the runtime is current — nothing to pull";
  }
  const digest = coreFacade.release.formatDecisionDigest(report.decisions);
  const head = `update --check: ${report.commits} commit(s) would be pulled. Nothing has changed yet.`;
  return digest === "" ? `${head}\n  no decisions landed in that range` : `${head}\n\n${digest}`;
}

export type GateField = "test" | "lint";

const GATE_FIELDS: Record<string, GateField> = {
  "test-command": "test",
  "lint-command": "lint",
};

// why: resolved without executing. Running the binary to see whether it exists would run it, which is not
// something a config write is allowed to do.
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const candidates = (base: string): string[] => [base, ...extensions.map((ext) => `${base}${ext}`)];

  if (name.includes("/") || name.includes("\\")) {
    return candidates(name).find((candidate) => existsSync(candidate)) ?? null;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    const found = candidates(join(dir, name)).find((candidate) => existsSync(candidate));
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * The only legitimate route to `grind.testCommand` and `grind.lintCommand`. Its absence is what produced the
 * bypass this rail exists to stop: the guard refused the edit and the CLI offered nothing in its place.
 *
 * hazard: `interactive` is a parameter rather than a `process.stdin.isTTY` read here, so the refusal can be
 * tested without a pty. It is a second layer only — the floor already refuses this command from inside an
 * agent session, and the operator's own terminal never reaches that check.
 */
export function setGateCommand(root: string, field: GateField, argv: string[], interactive: boolean): string {
  if (argv.length === 0) {
    throw new UsageError(`usage: tlc harness gate ${field}-command <command> [args...]`);
  }
  if (!interactive) {
    throw new UsageError(
      `tlc harness gate ${field}-command needs an interactive terminal — harness policy is the operator's to set, not a script's.`,
    );
  }
  const binary = argv[0] as string;
  if (resolveExecutable(binary) === null) {
    // why: AD-021 already treats a gate command that never resolved as a config fault. Refusing it at the
    // point of writing turns that fault into something the operator sees now instead of at the next gate.
    throw new UsageError(
      `\`${binary}\` was not found on PATH, and a gate command that cannot run is a config fault (AD-021).`,
    );
  }

  const path = projectConfigPath(root);
  const parsed = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  const grind = { ...((parsed.grind as Record<string, unknown> | undefined) ?? {}) };
  grind[field === "test" ? "testCommand" : "lintCommand"] = argv;
  parsed.grind = grind;

  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  // why: canonical 2-space JSON is byte-for-byte what these configs already are, so the diff is the changed
  // field and nothing else.
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  coreFacade.policy.refreshPolicyBaselines(root);

  return `grind.${field}Command = ${JSON.stringify(argv)}`;
}

export function helpText(): string {
  return `tlc harness — agent steering (gates / follow-up / handoff / policy)

Requires Node.js 24+ (Active LTS 24 or Current 26).

Read commands accept --json: status, doctor, obs, lessons, prices lookup, attest, policy.

QUICK
  tlc harness status              mode / grind / gates
  tlc harness version             runtime revision, and what this project last saw
  tlc harness update --check      what an update would pull, without pulling it
  tlc harness update              pull runtime + refresh skill/CLI, then doctor
  tlc harness doctor               health checklist
  tlc harness install             put the runtime in place from the installed npm package
  tlc harness build                compile dist/ for Node
  tlc harness test                 run the full local gate
  tlc harness help <topic>         documentation

TOPICS
  architecture | concepts | lessons | measure | prices | diagnose | init

CONTROL
  tlc harness grind [on|off]   tlc harness pause | resume   tlc harness mode solo|paired|focus
  tlc harness gate test-command <cmd> [args...]   tlc harness gate lint-command <cmd> [args...]
  tlc harness attest              tamper-evident record of what each session ran under
  tlc harness policy              show a policy that changed out of band; accept <path> to clear it

MEASURE
  tlc harness obs live|events|report|prune
  tlc harness prices refresh [all|cursor|litellm]
  tlc harness prices lookup <model-id>
  tlc harness lessons list|show|garden|sync-rules

PROJECT
  tlc harness init --minimal | tlc harness init --write --stdin-json
`;
}

export function pricesHelpText(): string {
  return `tlc harness prices

  tlc harness prices refresh [all|cursor|litellm]
  tlc harness prices lookup <model-id>

  refresh / refresh all   Cursor catalog + LiteLLM fallback
  refresh cursor          model-prices.cursor.json (tracked)
  refresh litellm         model-prices.litellm.json (local)
  lookup <model-id>       catalog key, pool, USD for 1M in + 1M out

  Resolution: overrides → Cursor → LiteLLM → null
  Documentation: tlc harness help prices
`;
}

export function resolveHarnessRoot(): string {
  const home = runtimeHome();
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

export function execBinPath(): string {
  return join(resolveHarnessRoot(), "bin", "tlc-exec");
}

export function buildBinPath(): string {
  return join(resolveHarnessRoot(), "bin", "tlc-build");
}

export type Action =
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "build" }
  | { kind: "update" }
  | { kind: "test" }
  | { kind: "grind"; on: boolean }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "mode"; value: string }
  | { kind: "gate"; field: GateField; argv: string[] }
  | { kind: "attest" }
  | { kind: "handoff" }
  | { kind: "version" }
  | { kind: "update-check" }
  | { kind: "policy"; accept: string[] }
  | { kind: "prices-help" }
  | { kind: "prices-refresh"; scope: string }
  | { kind: "prices-lookup"; modelId: string }
  | { kind: "entry"; entry: string; args: string[] }
  | { kind: "unknown"; cmd: string };

export function route(args: string[]): Action {
  const cmd = (args[0] ?? "status").toLowerCase();
  switch (cmd) {
    case "status":
    case "st":
    case "s":
      return { kind: "status" };
    case "build":
    case "rebuild":
      return { kind: "build" };
    case "update":
    case "upgrade": {
      const flags = args.slice(1);
      if (flags.includes("--check")) {
        return { kind: "update-check" };
      }
      // hazard: this accepted any flag in silence. An operator whose update had failed typed `--force`, got no
      // acknowledgement that it does not exist, and read the same failure as a refusal to force
      // ([/decisions/ad-048.md](/decisions/ad-048.md)).
      const leftover = unknownFlags(flags);
      if (leftover.length > 0) {
        throw new UsageError(
          leftover[0] === "--force"
            ? "update takes no --force: a managed runtime is already reset to upstream, and a linked clone is never written to. If update cannot move it, re-run the installer one-liner from the README."
            : `unknown flag: ${leftover[0]}\nusage: tlc harness update [--check]`,
        );
      }
      return { kind: "update" };
    }
    case "version":
    case "--version":
      return { kind: "version" };
    case "test":
      return { kind: "test" };
    case "grind":
    case "g": {
      const arg = (args[1] ?? "on").toLowerCase();
      if (arg === "on" || arg === "1" || arg === "true") {
        return { kind: "grind", on: true };
      }
      if (arg === "off" || arg === "0" || arg === "false") {
        return { kind: "grind", on: false };
      }
      throw new UsageError("usage: tlc harness grind [on|off]");
    }
    case "pause":
    case "p":
      return { kind: "pause" };
    case "resume":
    case "r":
      return { kind: "resume" };
    case "mode":
    case "m": {
      const modeArg = args[1];
      if (!modeArg) {
        throw new UsageError("usage: tlc harness mode <solo|paired|focus>");
      }
      return { kind: "mode", value: modeArg };
    }
    case "attest":
      return { kind: "attest" };
    case "handoff":
      return { kind: "handoff" };
    case "policy": {
      const sub = (args[1] ?? "").toLowerCase();
      if (!sub) {
        return { kind: "policy", accept: [] };
      }
      if (sub !== "accept") {
        throw new UsageError("usage: tlc harness policy [accept <path> [path...]]");
      }
      return { kind: "policy", accept: args.slice(2) };
    }
    case "gate": {
      const field = GATE_FIELDS[(args[1] ?? "").toLowerCase()];
      if (!field) {
        throw new UsageError("usage: tlc harness gate <test-command|lint-command> <command> [args...]");
      }
      return { kind: "gate", field, argv: args.slice(2) };
    }
    case "prices": {
      const sub = (args[1] ?? "").toLowerCase();
      if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
        return { kind: "prices-help" };
      }
      if (sub === "refresh") {
        return { kind: "prices-refresh", scope: args[2] ?? "all" };
      }
      if (sub === "lookup" || sub === "get") {
        const modelId = args[2];
        if (!modelId) {
          throw new UsageError(
            "usage: tlc harness prices lookup <model-id>\ndetail: tlc harness help prices",
          );
        }
        return { kind: "prices-lookup", modelId };
      }
      throw new UsageError(
        "usage: tlc harness prices refresh [all|cursor|litellm] | tlc harness prices lookup <model>\ndetail: tlc harness help prices",
      );
    }
    case "obs":
    case "o":
      return { kind: "entry", entry: "obs-cli", args: args.slice(1) };
    // why: doctor used to drop its arguments, so every flag reached the entry as an empty list. It forwards
    // them now, which is what lets --json arrive at the tool.
    case "doctor":
    case "doc":
      return { kind: "entry", entry: "doctor", args: args.slice(1) };
    case "lessons":
    case "lesson":
      return { kind: "entry", entry: "lessons-cli", args: args.slice(1) };
    case "init":
      return { kind: "entry", entry: "init-project", args: args.slice(1) };
    case "install":
      return { kind: "entry", entry: "install-runtime", args: args.slice(1) };
    case "help":
    case "-h":
    case "--help": {
      const topic = args[1];
      if (!topic) {
        return { kind: "help" };
      }
      return { kind: "entry", entry: "help-topic", args: [topic] };
    }
    default:
      return { kind: "unknown", cmd };
  }
}

export type TestStep = { label: string; bin: string; args: string[] };

// invariant: every suite is launched through the hermetic setup module. Without it the suite reads
// CLAUDE_PROJECT_DIR from whatever started it, so 22 tests that build a fixture in a temp directory resolved
// against the real repository — green from a shell, red from inside a hook.
export const TEST_ENV_IMPORT = ["--import", "./tools/test-env.mjs"];

export function buildTestSteps(): TestStep[] {
  return [
    // why: `--error-on-warnings`. A warn-level rule does not change biome's exit code, so three fixable warnings
    // sat in this repo across several green gates until someone read the output by hand. Escalating every group to
    // `error` in biome.json was measured instead and rejected: it enables each group's non-recommended rules too,
    // which produced 3763 findings and included `noBarrelFile` and `noReExportAll` — the two rules that forbid the
    // core facade this architecture is built on (AD-004) — and `noNodejsModules` in a Node CLI.
    { label: "biome check", bin: "npx", args: ["biome", "check", "--error-on-warnings"] },
    { label: "tsc --noEmit", bin: "npx", args: ["tsc", "--noEmit"] },
    { label: "src suite", bin: "node", args: [...TEST_ENV_IMPORT, "--test", "src/**/__test__/*.test.ts"] },
    { label: "tools suite", bin: "node", args: [...TEST_ENV_IMPORT, "--test", "tools/__test__/*.test.ts"] },
    { label: "check-boundaries", bin: "node", args: ["tools/check-boundaries.ts"] },
    // why: `--error-on-warnings` above cannot see a rule that was suppressed rather than fixed, and biome accepts
    // any text after the colon. This is what makes the reason a reason ([/decisions/ad-051.md](/decisions/ad-051.md)).
    { label: "check-suppressions", bin: "node", args: ["tools/check-suppressions.ts"] },
    { label: "check-wiring", bin: "node", args: ["tools/check-wiring.ts"] },
    { label: "check-docs-bundle", bin: "node", args: ["tools/check-docs-bundle.ts"] },
    { label: "capabilities in sync", bin: "node", args: ["tools/render-capabilities.ts", "--check"] },
    { label: "changelog in sync", bin: "node", args: ["tools/render-changelog.ts", "--check"] },
  ];
}

export type StepSpawner = (bin: string, args: string[], cwd: string) => { status: number | null };

export function runTestSteps(
  steps: TestStep[],
  cwd: string,
  spawner: StepSpawner = (bin, spawnArgs, spawnCwd) =>
    spawnSync(bin, spawnArgs, { cwd: spawnCwd, stdio: "inherit" }),
): number {
  for (const step of steps) {
    console.log(`tlc harness test: running ${step.label}`);
    const result = spawner(step.bin, step.args, cwd);
    const status = result.status ?? 1;
    if (status !== 0) {
      console.error(`tlc harness test: FAILED at "${step.label}" (exit ${status})`);
      return status;
    }
  }
  console.log("tlc harness test: all steps passed");
  return 0;
}

function announceNewCapabilities(root: string, runtimeRoot: string): void {
  const catalog = coreFacade.capability.loadCatalog(runtimeRoot);
  const policy = coreFacade.capability.readProjectPolicyRaw(root);
  if (!catalog || !policy) {
    return;
  }
  const seen = coreFacade.capability.readRuntimeSeen(root);
  const fresh = coreFacade.capability.listNewlyAnnounceable(policy, catalog, seen.catalogVersion);
  if (fresh.length === 0) {
    return;
  }
  console.log("");
  console.log(coreFacade.capability.formatCapabilityDigest(fresh));
  console.log("");
  void coreFacade.capability.writeRuntimeSeen(root, catalog.catalogVersion);
}

/**
 * why: the shape the capability digest established — what is new, what it costs you, announced once. A per-project
 * seen revision is what makes "once" true, and the reason it matters is that an announcement which repeats becomes
 * noise, and noise is filtered out by the reader ([/decisions/ad-031.md](/decisions/ad-031.md)).
 *
 * invariant: a project with no seen marker is not shown every decision ever written. The first update records where
 * it stands and announces nothing, because a wall of thirty entries is indistinguishable from no message at all.
 */
function announceLandedDecisions(root: string, dest: string, before: string | null): void {
  const now = runtimeRevision(dest).revision;
  if (now === null) {
    return;
  }
  const seen = coreFacade.release.readReleaseSeen(root)?.revision ?? before;
  if (seen === null || seen === now) {
    void coreFacade.release.writeReleaseSeen(root, now);
    return;
  }
  const added = spawnSync(
    "git",
    ["-C", dest, "diff", "--name-only", "--diff-filter=A", `${seen}..${now}`, "--", "docs/decisions"],
    { encoding: "utf8", env: process.env },
  );
  if ((added.status ?? 1) !== 0) {
    // why: a force-push upstream can leave the seen revision unreachable. Reporting that beats throwing on the
    // path an operator is standing in front of.
    console.log(`update: cannot list what landed since ${seen} — that revision is no longer in the checkout`);
    void coreFacade.release.writeReleaseSeen(root, now);
    return;
  }
  const files = (added.stdout ?? "")
    .split("\n")
    .map((line) => line.trim().split("/").pop() ?? "")
    .filter(Boolean);
  const digest = coreFacade.release.formatDecisionDigest(coreFacade.release.readDecisions(dest, files));
  if (digest !== "") {
    console.log("");
    console.log(digest);
    console.log("");
  }
  void coreFacade.release.writeReleaseSeen(root, now);
}

function runUpdate(root: string): never {
  const dest = resolveHarnessRoot();
  const revisionBefore = runtimeRevision(dest).revision;
  const home = runtimeHome();
  console.log(`update: runtime → ${dest}`);

  if (!existsSync(join(dest, "bin", "tlc-exec.mjs"))) {
    console.error(`update: missing install at ${home}`);
    console.error("update: install once with the curl/irm installer from the README, then retry.");
    process.exit(1);
  }

  // invariant: classified from the configured home, never from `dest`. `dest` is `realpathSync`-resolved, so asking
  // it hides the link and update writes into somebody's clone.
  const kind = runtimePathKind(home);
  if (kind === "linked") {
    // invariant: no git command runs against a linked clone, not even a read. The machine-local refresh below is
    // the whole of what update may do here ([/decisions/ad-046.md](/decisions/ad-046.md)).
    console.log(linkedRuntimeMessage(home, dest === home ? null : dest));
  } else if (kind === "npm") {
    // why: the registry owns fetch, integrity and rollback here, so update's whole job is to bump the package and
    // re-materialise. No git command runs against an npm-delivered runtime, for the same reason none runs against
    // a linked clone: it is not a checkout ([/decisions/ad-056.md](/decisions/ad-056.md)).
    const bump = spawnSync("npm", ["install", "-g", `${NPM_PACKAGE}@latest`], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    if ((bump.status ?? 1) !== 0) {
      console.error(npmUpdateFailureMessage());
      process.exit(bump.status ?? 1);
    }
    const sync = spawnSync(execBinPath(), ["install-runtime"], { stdio: "inherit", env: process.env });
    if ((sync.status ?? 1) !== 0) {
      process.exit(sync.status ?? 1);
    }
  } else if (kind === "unmanaged") {
    console.log(unmanagedRuntimeMessage(dest));
  } else {
    const fetch = spawnSync("git", ["-C", dest, "fetch", "origin"], {
      stdio: "inherit",
      env: process.env,
    });
    if ((fetch.status ?? 1) !== 0) {
      console.error(fetchFailureMessage(dest));
      process.exit(fetch.status ?? 1);
    }
    const mergeRef = upstreamRef(dest);
    // why: a hard reset, not a fast-forward merge. The artifact is the harness's own, so a local change in it is
    // never the operator's work and never a conflict they have to resolve. `dist/` bundles rebuilt by an older
    // update with a different bundler made every fast-forward fail — measured 223,390 bytes from Bun against
    // 228,018 from esbuild for the same source ([/decisions/ad-046.md](/decisions/ad-046.md)).
    //
    // invariant: `state/` and `config.json` are gitignored, so a reset cannot remove them. A test asserts that
    // rather than trusting it.
    const reset = spawnSync("git", ["-C", dest, "reset", "--hard", mergeRef], {
      encoding: "utf8",
      env: process.env,
    });
    if ((reset.status ?? 1) !== 0) {
      console.error(resetFailureMessage(dest, mergeRef, `${reset.stderr ?? ""}${reset.stdout ?? ""}`));
      process.exit(reset.status ?? 1);
    }
    const after = runtimeRevision(dest).revision;
    console.log(
      revisionBefore === after
        ? `update: runtime already at ${after ?? "unknown"} — nothing to move`
        : `update: runtime ${revisionBefore ?? "unknown"} → ${after ?? "unknown"}`,
    );
  }

  const binDir = process.env.TLC_BIN_DIR || join(homedir(), ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(home, "..", "skills"), { recursive: true });

  if (process.platform === "win32") {
    const installPs1 = join(dest, "install.ps1");
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installPs1], {
      stdio: "inherit",
      env: { ...process.env, TLC_HOME: home },
      cwd: dest,
    });
    if ((r.status ?? 1) !== 0) {
      process.exit(r.status ?? 1);
    }
  } else {
    const tlcBin = join(dest, "bin", "tlc");
    const skillSrc = join(dest, "skills", "harness-init");
    const skillDest = join(home, "..", "skills", "harness-init");
    spawnSync("ln", ["-sfn", tlcBin, join(binDir, "tlc")], { stdio: "inherit" });
    if (!existsSync(skillSrc)) {
      console.error(`update: missing skill at ${skillSrc}`);
      process.exit(1);
    }
    spawnSync("ln", ["-sfn", skillSrc, skillDest], { stdio: "inherit" });
    console.log(`update: skill → ${skillDest}`);
    const hooks = spawnSync(process.execPath, [join(dest, "bin", "write-user-hooks.mjs")], {
      stdio: "inherit",
      env: { ...process.env, TLC_HOME: home },
    });
    if ((hooks.status ?? 1) !== 0) {
      console.log("update: hooks unchanged (merge manually or: node bin/write-user-hooks.mjs --force)");
    }
  }

  // invariant: never build into the artifact when it is already complete. `dist/` is committed for the Node
  // fallback (AD-012) and the gate keeps it matching `src/`, so the pulled revision already carries the right
  // bundles. Rebuilding them with a different bundler is what dirtied every user's checkout
  // ([/decisions/ad-046.md](/decisions/ad-046.md)).
  const missing = missingBundles(dest);
  if (missing.length === 0) {
    console.log("update: dist/ complete — no rebuild, so the runtime path stays clean");
  } else if (existsSync(buildBinPath())) {
    console.log(`update: ${missing.length} bundle(s) missing — building`);
    const build = spawnSync(buildBinPath(), [], { stdio: "inherit", env: process.env });
    if ((build.status ?? 1) !== 0) {
      console.log(`update: build failed — ${missing.length} bundle(s) still missing from dist/`);
    }
  }

  announceNewCapabilities(root, dest);
  announceLandedDecisions(root, dest, revisionBefore);

  console.log("update: running doctor…");
  const doctor = spawnSync(execBinPath(), ["doctor"], {
    stdio: "inherit",
    env: { ...process.env, TLC_PROJECT_DIR: root },
  });
  console.log("update: ok — reload if hooks/skill should refresh");
  process.exit(doctor.status ?? 0);
}

function runEntry(entry: string, toolArgs: string[], root: string): never {
  const r = spawnSync(execBinPath(), [entry, ...toolArgs], {
    stdio: "inherit",
    env: { ...process.env, TLC_PROJECT_DIR: root },
  });
  process.exit(r.status ?? 1);
}

function main(argv: string[]): void {
  const root = resolveProjectRoot();
  const group = (argv[0] ?? "").toLowerCase();
  if (group !== "harness") {
    console.error(`unknown: ${argv[0] ?? ""}`);
    console.error(
      "usage: tlc harness <status|doctor|help|grind|pause|resume|mode|obs|prices|lessons|init|update|test|build>",
    );
    process.exit(1);
  }

  const { json, rest: args } = takeJsonFlag(argv.slice(1));
  let action: Action;
  try {
    action = route(args);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  switch (action.kind) {
    case "status": {
      const leftover = unknownFlags(args.slice(1));
      if (leftover.length > 0) {
        console.error(`unknown flag: ${leftover[0]}`);
        console.error("usage: tlc harness status [--json]");
        process.exit(1);
      }
      if (json) {
        emitJson(statusJson(root));
      } else {
        console.log(statusText(root));
      }
      break;
    }
    case "handoff": {
      const leftover = unknownFlags(args.slice(1));
      if (leftover.length > 0) {
        console.error(`unknown flag: ${leftover[0]}`);
        console.error("usage: tlc harness handoff [--json]");
        process.exit(1);
      }
      const report = handoffJson(root);
      if (json) {
        emitJson(report);
      } else {
        console.log(handoffText(report));
      }
      break;
    }
    case "attest": {
      const leftover = unknownFlags(args.slice(1));
      if (leftover.length > 0) {
        console.error(`unknown flag: ${leftover[0]}`);
        console.error("usage: tlc harness attest [--json]");
        process.exit(1);
      }
      const report = attestJson(root);
      if (json) {
        emitJson(report);
      } else {
        console.log(attestText(root));
      }
      // why: a broken chain exits non-zero so a pipeline can gate on it. An empty chain is not broken.
      process.exit(report.ok ? 0 : 1);
      break;
    }
    case "policy": {
      if (action.accept.length === 0 && !args.includes("accept")) {
        if (json) {
          emitJson(policyJson(root));
        } else {
          console.log(policyText(root));
        }
        break;
      }
      try {
        console.log(acceptPolicy(root, action.accept, Boolean(process.stdin.isTTY)));
      } catch (error) {
        if (error instanceof UsageError) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      }
      break;
    }
    case "help":
      console.log(helpText());
      break;
    case "build": {
      const r = spawnSync(buildBinPath(), [], { stdio: "inherit", env: process.env });
      process.exit(r.status ?? 1);
      break;
    }
    case "version":
      if (json) {
        emitJson(versionJson(root));
      } else {
        console.log(versionText(root));
      }
      break;
    case "update-check": {
      const dest = resolveHarnessRoot();
      const report = pendingUpdate(dest, upstreamRef(dest));
      if (json) {
        emitJson(report);
      } else {
        console.log(pendingText(report));
      }
      break;
    }
    case "update":
      runUpdate(root);
      break;
    case "test": {
      const status = runTestSteps(buildTestSteps(), process.cwd());
      process.exit(status);
      break;
    }
    case "grind":
      console.log(setGrind(root, action.on));
      break;
    case "pause":
      console.log(setPaused(root, true));
      break;
    case "resume":
      console.log(setPaused(root, false));
      break;
    case "mode":
      try {
        console.log(setMode(root, action.value));
      } catch (error) {
        if (error instanceof UsageError) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      }
      break;
    case "gate":
      try {
        console.log(setGateCommand(root, action.field, action.argv, process.stdin.isTTY === true));
      } catch (error) {
        if (error instanceof UsageError) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      }
      break;
    case "prices-help":
      console.log(pricesHelpText());
      break;
    case "prices-refresh":
      runEntry("refresh-model-prices", [action.scope], root);
      break;
    case "prices-lookup":
      runEntry("price-lookup", json ? [action.modelId, JSON_FLAG] : [action.modelId], root);
      break;
    case "entry":
      runEntry(action.entry, json ? [...action.args, JSON_FLAG] : action.args, root);
      break;
    case "unknown":
      console.error(`unknown: ${action.cmd}`);
      console.log(helpText());
      process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
