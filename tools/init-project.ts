import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { NPM_PACKAGE, runtimeVersion } from "../bin/tlc-cli.ts";
import { applyCursorWiring, renderCursorHooksDocument } from "../bin/write-user-hooks.mjs";
import type { WiringEntry } from "../src/contracts/index.ts";
import { coreFacade } from "../src/core/index.ts";
import { DEFAULTS } from "../src/core/policy/policy.defaults.ts";
import { claudeConfigDir, cursorConfigDir, projectConfigPath, runtimeHome } from "../src/platform/paths.ts";
import { render, type Screen } from "../src/platform/screen.ts";
import { PLAIN, type Style } from "../src/platform/style.ts";
import { applyClaudeWiring } from "../src/providers/claude/claude.wiring.ts";

export class UsageError extends Error {}

export type InitFlags = {
  dryRun: boolean;
  write: boolean;
  minimal: boolean;
  stdinJson: boolean;
  force: boolean;
};

export function parseFlags(args: readonly string[]): InitFlags {
  return {
    dryRun: args.includes("--dry-run"),
    write: args.includes("--write") || args.includes("--minimal"),
    minimal: args.includes("--minimal"),
    stdinJson: args.includes("--stdin-json"),
    force: args.includes("--force"),
  };
}

export function usageScreen(): Screen {
  return {
    title: "harness init",
    sections: [
      {
        lines: `  tlc harness init --dry-run
  tlc harness init --write [--stdin-json] [--force]
  tlc harness init --minimal

--minimal writes a safe agnostic stub (grind/ship off). Prefer the harness-init skill for full discovery.`.split(
          "\n",
        ),
      },
    ],
  };
}

// why: plain by default and never given a style here — the only caller throws it as a UsageError, and an error
// message is printed on a path that may be redirected.
export function usageText(style: Style = PLAIN): string {
  return render(usageScreen(), style);
}

export function launcherPath(home = runtimeHome()): string {
  return join(home, "bin", "tlc-exec.mjs");
}

/**
 * invariant: the same command the provider wiring writes, on every platform — `node`, resolved by the host that
 * spawns it. The Windows `cmd /c` wrapper this replaced existed on one of the two providers only
 * ([/decisions/ad-097.md](/decisions/ad-097.md)).
 */
const SHIM_COMMAND = { command: "node", argsPrefix: [] as string[] };

type ShimSpec = {
  hookEvent: string;
  handler: string;
  timeoutSeconds: number;
  loopLimit?: number;
  matcher?: string;
};

const CURSOR_SHIM_SPECS: readonly ShimSpec[] = [
  { hookEvent: "sessionStart", handler: "session-start", timeoutSeconds: 10 },
  { hookEvent: "sessionEnd", handler: "session-end", timeoutSeconds: 10 },
  { hookEvent: "preToolUse", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "beforeShellExecution", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "beforeMCPExecution", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "beforeReadFile", handler: "tool-before", timeoutSeconds: 5 },
  { hookEvent: "subagentStart", handler: "subagent-start", timeoutSeconds: 5 },
  { hookEvent: "stop", handler: "stop", timeoutSeconds: 120, loopLimit: 5 },
  { hookEvent: "afterAgentResponse", handler: "response-after", timeoutSeconds: 5, matcher: "AgentResponse" },
];

const CLAUDE_SHIM_SPECS: readonly ShimSpec[] = [
  { hookEvent: "SessionStart", handler: "session-start", timeoutSeconds: 10 },
  { hookEvent: "SessionEnd", handler: "session-end", timeoutSeconds: 10 },
  { hookEvent: "PreToolUse", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "SubagentStart", handler: "subagent-start", timeoutSeconds: 5 },
  { hookEvent: "Stop", handler: "stop", timeoutSeconds: 120, loopLimit: 5 },
  { hookEvent: "MessageDisplay", handler: "response-after", timeoutSeconds: 5 },
];

export function cursorShimEntries(launcher: string): WiringEntry[] {
  const { command, argsPrefix } = SHIM_COMMAND;
  return CURSOR_SHIM_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command,
    args: [...argsPrefix, launcher, "shim", spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
    ...(spec.loopLimit !== undefined ? { loopLimit: spec.loopLimit } : {}),
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
  }));
}

export function claudeShimEntries(launcher: string): WiringEntry[] {
  return CLAUDE_SHIM_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command: "node",
    args: [launcher, "shim", spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
    ...(spec.loopLimit !== undefined ? { loopLimit: spec.loopLimit } : {}),
  }));
}

/**
 * The paths `init` writes into the project that must not be committed.
 *
 * hazard: this was one line, `.tlc/harness/state/`, while `init` also writes two shim documents containing an
 * absolute path to the runtime on the machine that ran it. A user committed a `settings.json` naming their own
 * home directory, and the next developer's hook pointed at a path that does not exist. This repository has
 * ignored both files by hand since 2026-07-30 — commit 81c5830, "keep generated shims out of git", with the
 * comment "per-machine artifacts rather than shared configuration" — so the protection existed here and was never
 * delivered to anyone using the product ([/decisions/ad-095.md](/decisions/ad-095.md)).
 *
 * invariant: derived from what `init` writes. `PROJECT_SHIMS` is the same list the wiring below writes to, so a
 * new shim cannot be added without appearing here.
 */
export const PROJECT_SHIMS = [join(".cursor", "hooks.json"), join(".claude", "settings.json")] as const;

export const GITIGNORE_STATE = ".tlc/harness/state/";

/** why: posix separators, because a `.gitignore` is read by git and not by the platform that wrote it. */
export function gitignoreEntries(): string[] {
  return [GITIGNORE_STATE, ...PROJECT_SHIMS.map((path) => path.split(sep).join("/"))];
}

export function mergeGitignore(root: string): { text: string; changed: boolean } {
  const path = join(root, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split("\n");
  const missing = gitignoreEntries().filter((entry) => !lines.includes(entry));
  if (missing.length === 0) {
    return { text: existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`, changed: false };
  }
  lines.push(...missing);
  const withoutTrailingBlank = lines.filter((line, index, all) => line.length > 0 || index < all.length - 1);
  return { text: `${withoutTrailingBlank.join("\n").replace(/\n+$/, "")}\n`, changed: true };
}

/**
 * hazard: this returned `DEFAULTS` whole, and the wizard's `--stdin-json` carried every knob it had collected. Both
 * wrote values nobody chose, and each one shadows the machine tier for ever — raise a number there afterwards and
 * no such project sees it. Measured on one repository: 29 keys restating the tiers below
 * ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * invariant: pruning cannot change the effective policy, because a leaf is dropped only when the tiers below
 * already resolve to it. An existing config is still returned untouched — rewriting an operator's file is not
 * this command's business.
 */
export function resolvePolicy(root: string, flags: InitFlags, stdinText: string | null): unknown {
  if (flags.stdinJson && !flags.minimal) {
    if (!stdinText || stdinText.trim() === "") {
      throw new Error("stdin-json: empty stdin");
    }
    return prune(JSON.parse(stdinText) as Record<string, unknown>);
  }
  if (!flags.minimal && !flags.stdinJson && existsSync(projectConfigPath(root))) {
    return JSON.parse(readFileSync(projectConfigPath(root), "utf8"));
  }
  /**
   * hazard: this returned `DEFAULTS`, and pruning it was not enough. Against a machine tier that enabled things,
   * the shipped defaults *differ* — so a fresh project wrote `comments.enabled: false` and turned off, in that
   * repository, a capability the operator had switched on for the machine. A project that has decided nothing must
   * say nothing ([/decisions/ad-101.md](/decisions/ad-101.md)).
   */
  return { version: DEFAULTS.version };
}

function prune(policy: Record<string, unknown>): Record<string, unknown> {
  return coreFacade.policy.pruneShadowed(policy, coreFacade.policy.resolvedWithoutProjectTier());
}

export type ProviderPresence = { cursor: boolean; claude: boolean };

export function detectProviders(dirs: { cursor?: string; claude?: string } = {}): ProviderPresence {
  return {
    cursor: existsSync(dirs.cursor ?? cursorConfigDir()),
    claude: existsSync(dirs.claude ?? claudeConfigDir()),
  };
}

export type InitPlan = {
  policy: unknown;
  cursorHooksDocument: unknown | null;
  claudeHooksPreview: WiringEntry[] | null;
  gitignoreEntries: string[];
};

export function buildPlan(
  root: string,
  flags: InitFlags,
  stdinText: string | null,
  presence: ProviderPresence,
): InitPlan {
  const policy = resolvePolicy(root, flags, stdinText);
  const launcher = launcherPath();
  return {
    policy,
    cursorHooksDocument: presence.cursor ? renderCursorHooksDocument(cursorShimEntries(launcher)) : null,
    claudeHooksPreview: presence.claude ? claudeShimEntries(launcher) : null,
    gitignoreEntries: gitignoreEntries(),
  };
}

export type ApplyOutcome = {
  configPath: string;
  /** why reported: silence after keeping a file reads as having written it. */
  configKept: boolean;
  cursor: { skipped: true } | { skipped: false; status: string; target: string };
  claude: { skipped: true } | { skipped: false; status: string; target: string };
};

/**
 * why exported: the repository's convention is that text is built by a named function and printed by the caller,
 * so what an operator reads can be asserted. Silence after keeping a file reads as having written it.
 */
export function configLine(outcome: ApplyOutcome): string {
  return outcome.configKept
    ? `kept ${outcome.configPath} — already configured; delete it to start over, or run the wizard to replace it`
    : `wrote ${outcome.configPath}`;
}

/**
 * why: major.minor, not bare major — this package is pre-1.0, where a 0.x minor bump can also break,
 * so pinning only the major would silently serve a schema from the wrong minor. An unreadable
 * `package.json` falls back to unpkg's latest resolution rather than a version string that goes stale.
 */
function schemaUrl(): string {
  const version = runtimeVersion(runtimeHome());
  if (version === null) {
    return `https://unpkg.com/${NPM_PACKAGE}/schema.json`;
  }
  const [major, minor] = version.split(".");
  return `https://unpkg.com/${NPM_PACKAGE}@${major}.${minor}/schema.json`;
}

export function applyPlan(
  root: string,
  flags: InitFlags,
  presence: ProviderPresence,
  stdinText: string | null,
): ApplyOutcome {
  const policy = resolvePolicy(root, flags, stdinText);
  const configPath = projectConfigPath(root);
  /**
   * hazard: this wrote unconditionally. `init --minimal` on a configured project replaced the operator's file —
   * with the whole default policy before, with a bare version marker after that changed. Both destroy choices
   * nobody asked to undo, and neither said so ([/decisions/ad-101.md](/decisions/ad-101.md)).
   *
   * invariant: an existing config is replaced only when the operator supplied one to replace it with. That is what
   * `--stdin-json` is — the wizard's collected answers — and it is the one route that carries consent. Everything
   * else keeps the file. This is the rule `linkDir` already follows: a real file at the target is somebody's work.
   */
  const kept = existsSync(configPath) && !flags.stdinJson;
  if (!kept) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify({ $schema: schemaUrl(), ...(policy as Record<string, unknown>) }, null, 2)}\n`,
    );
  }

  const launcher = launcherPath();

  const cursor = presence.cursor
    ? (() => {
        const result = applyCursorWiring(
          {
            target: join(root, ".cursor", "hooks.json"),
            strategy: "replace",
            entries: cursorShimEntries(launcher),
          },
          { force: flags.force },
        );
        return { skipped: false as const, status: result.status, target: result.target };
      })()
    : { skipped: true as const };

  const claude = presence.claude
    ? (() => {
        const result = applyClaudeWiring(join(root, ".claude", "settings.json"), claudeShimEntries(launcher));
        return {
          skipped: false as const,
          status: result.ok ? (result.changed ? "written" : "unchanged") : "failed",
          target: join(root, ".claude", "settings.json"),
        };
      })()
    : { skipped: true as const };

  const gitignore = mergeGitignore(root);
  writeFileSync(join(root, ".gitignore"), gitignore.text);

  return { configPath, configKept: kept, cursor, claude };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function main(argv: string[]): Promise<void> {
  const root = process.env.TLC_PROJECT_DIR ?? process.cwd();
  const flags = parseFlags(argv);

  if (!flags.dryRun && !flags.write) {
    throw new UsageError(usageText());
  }

  const stdinText = flags.stdinJson ? await readStdin() : null;
  const presence = detectProviders();

  if (flags.dryRun) {
    console.log(JSON.stringify(buildPlan(root, flags, stdinText, presence), null, 2));
    return;
  }

  const outcome = applyPlan(root, flags, presence, stdinText);
  console.log(configLine(outcome));
  if (outcome.cursor.skipped) {
    console.log("init: cursor not installed — skipped project hooks.json");
  } else {
    console.log(`hooks: ${outcome.cursor.status} ${outcome.cursor.target}`);
  }
  if (outcome.claude.skipped) {
    console.log("init: claude not installed — skipped project settings.json");
  } else {
    console.log(`hooks: ${outcome.claude.status} ${outcome.claude.target}`);
  }
  console.log("updated .gitignore harness entries");
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
