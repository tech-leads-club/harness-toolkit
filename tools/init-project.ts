import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyCursorWiring, renderCursorHooksDocument } from "../bin/write-user-hooks.mjs";
import type { WiringEntry } from "../src/contracts/index.ts";
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

function shimCommand(platform = process.platform): { command: string; argsPrefix: string[] } {
  if (platform === "win32") {
    return { command: "cmd", argsPrefix: ["/c", "node"] };
  }
  return { command: "node", argsPrefix: [] };
}

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
  const { command, argsPrefix } = shimCommand();
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

export const GITIGNORE_LINE = ".tlc/harness/state/";

export function mergeGitignore(root: string): { text: string; changed: boolean } {
  const path = join(root, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split("\n");
  const alreadyPresent = lines.includes(GITIGNORE_LINE);
  if (alreadyPresent) {
    return { text: existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`, changed: false };
  }
  lines.push(GITIGNORE_LINE);
  const withoutTrailingBlank = lines.filter((line, index, all) => line.length > 0 || index < all.length - 1);
  return { text: `${withoutTrailingBlank.join("\n").replace(/\n+$/, "")}\n`, changed: true };
}

export function resolvePolicy(root: string, flags: InitFlags, stdinText: string | null): unknown {
  if (flags.stdinJson && !flags.minimal) {
    if (!stdinText || stdinText.trim() === "") {
      throw new Error("stdin-json: empty stdin");
    }
    return JSON.parse(stdinText);
  }
  if (!flags.minimal && !flags.stdinJson && existsSync(projectConfigPath(root))) {
    return JSON.parse(readFileSync(projectConfigPath(root), "utf8"));
  }
  return DEFAULTS;
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
  gitignoreLine: string;
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
    gitignoreLine: GITIGNORE_LINE,
  };
}

export type ApplyOutcome = {
  configPath: string;
  cursor: { skipped: true } | { skipped: false; status: string; target: string };
  claude: { skipped: true } | { skipped: false; status: string; target: string };
};

export function applyPlan(
  root: string,
  flags: InitFlags,
  presence: ProviderPresence,
  stdinText: string | null,
): ApplyOutcome {
  const policy = resolvePolicy(root, flags, stdinText);
  const configPath = projectConfigPath(root);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(policy, null, 2)}\n`);

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

  return { configPath, cursor, claude };
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
  console.log(`wrote ${outcome.configPath}`);
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
