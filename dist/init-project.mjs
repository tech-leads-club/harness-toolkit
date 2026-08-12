import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// tools/init-project.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";

// bin/write-user-hooks.mjs
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";

// src/providers/claude/claude.wiring.ts
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join as join2 } from "node:path";

// src/platform/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function harnessDir(root) {
  return join(root, ".tlc", "harness");
}
function conventionalRuntimeHome() {
  return join(homedir(), ".tlc", "harness");
}
function runtimeHome(env = process.env) {
  return env.TLC_HOME ?? conventionalRuntimeHome();
}
function projectConfigPath(root) {
  return join(harnessDir(root), "config.json");
}
function claudeConfigDir() {
  const custom = process.env.CLAUDE_CONFIG_DIR?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), ".claude");
}
function cursorConfigDir() {
  const custom = process.env.CURSOR_CONFIG_DIR?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), ".cursor");
}

// src/providers/claude/claude.wiring.ts
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isHooksRecord(value) {
  return isPlainRecord(value);
}
function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) => bKeys.includes(key) && deepEqual(a[key], b[key]));
  }
  return false;
}
function desiredHooksFor(entries) {
  const hooks = {};
  for (const entry of entries) {
    const group = {
      hooks: [{ type: "command", command: entry.command, args: entry.args }]
    };
    hooks[entry.hookEvent] = [...hooks[entry.hookEvent] ?? [], group];
  }
  return hooks;
}
var LAUNCHER_MARKER = "tlc-exec.mjs";
function isHarnessGroup(group) {
  return JSON.stringify(group ?? null).includes(LAUNCHER_MARKER);
}
function canonicalLauncherPath(path, resolve = realpathSync) {
  try {
    return resolve(path);
  } catch {
    return path;
  }
}
function canonicalizeGroups(groups, resolve) {
  return JSON.parse(JSON.stringify(groups ?? null, (_key, value) => typeof value === "string" && value.includes(LAUNCHER_MARKER) ? canonicalLauncherPath(value, resolve) : value));
}
function mergeClaudeSettings(existingText, entries) {
  const desired = desiredHooksFor(entries);
  let settings = {};
  if (existingText !== null && existingText.trim() !== "") {
    let parsed;
    try {
      parsed = JSON.parse(existingText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, block: JSON.stringify({ hooks: desired }, null, 2) };
    }
    if (!isPlainRecord(parsed)) {
      return {
        ok: false,
        error: "settings.json root is not a JSON object",
        block: JSON.stringify({ hooks: desired }, null, 2)
      };
    }
    settings = parsed;
  }
  const currentHooks = isHooksRecord(settings.hooks) ? settings.hooks : {};
  const mergedHooks = { ...currentHooks };
  let changed = false;
  for (const [hookEvent, groups] of Object.entries(desired)) {
    const existingGroups = mergedHooks[hookEvent] ?? [];
    const foreign = existingGroups.filter((group) => !isHarnessGroup(group));
    const nextGroups = [...foreign, ...groups];
    if (!deepEqual(canonicalizeGroups(existingGroups), canonicalizeGroups(nextGroups))) {
      changed = true;
    }
    mergedHooks[hookEvent] = nextGroups;
  }
  const mergedSettings = { ...settings, hooks: mergedHooks };
  return { ok: true, settingsText: JSON.stringify(mergedSettings, null, 2), changed };
}
function applyClaudeWiring(settingsPath, entries) {
  const existingText = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  const result = mergeClaudeSettings(existingText, entries);
  if (result.ok && result.changed) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, result.settingsText, "utf8");
  }
  return result;
}
// src/providers/provider.degrade.ts
var NO_HUMAN_MODES = new Set(["bypassPermissions", "dontAsk"]);
// bin/write-user-hooks.mjs
var CURSOR_MARKER = "tlc-exec.mjs";
function quoteIfNeeded(token) {
  return token.includes(" ") ? `"${token}"` : token;
}
function commandStringFor(entry) {
  return [entry.command, ...entry.args].map(quoteIfNeeded).join(" ");
}
function renderCursorHooksDocument(entries) {
  const hooks = {};
  for (const entry of entries) {
    const rendered = { command: commandStringFor(entry), timeout: entry.timeoutSeconds };
    if (entry.failClosed) {
      rendered.failClosed = true;
    }
    if (entry.matcher !== undefined) {
      rendered.matcher = entry.matcher;
    }
    if (entry.loopLimit !== undefined) {
      rendered.loop_limit = entry.loopLimit;
    }
    hooks[entry.hookEvent] = [...hooks[entry.hookEvent] ?? [], rendered];
  }
  return { version: 1, hooks };
}
function isCursorWired(targetPath) {
  return existsSync2(targetPath) && readFileSync2(targetPath, "utf8").includes(CURSOR_MARKER);
}
function applyCursorWiring(wiring, { force = false } = {}) {
  const targetPath = wiring.target;
  const document = renderCursorHooksDocument(wiring.entries);
  const rendered = `${JSON.stringify(document, null, 2)}
`;
  if (existsSync2(targetPath) && !force) {
    if (isCursorWired(targetPath)) {
      return { status: "unchanged", target: targetPath };
    }
    return {
      status: "refused",
      target: targetPath,
      reason: `${targetPath} exists without harness entries — rerun with --force to overwrite, or merge manually.`
    };
  }
  mkdirSync2(dirname2(targetPath), { recursive: true });
  writeFileSync2(targetPath, rendered);
  return { status: "written", target: targetPath };
}
if (false) {}

// src/core/observability/observability.types.ts
var DEFAULT_OBS = {
  enabled: true,
  signalPath: "obs.jsonl",
  debugPath: "debug.jsonl",
  debugEnabled: false,
  includePayloads: false,
  maxAttrChars: 500,
  sessionCostAlertUsd: 5,
  retentionDays: 14,
  maxSignalEvents: 50000,
  globalSpool: false
};
var SIGNAL_KINDS = new Set([
  "session.start",
  "session.end",
  "generation.end",
  "tool.fail",
  "subagent.start",
  "subagent.end",
  "prompt.submit",
  "compact",
  "gate.outcome",
  "cost.turn",
  "cost.session_alert",
  "ship.claim",
  "policy.deny",
  "policy.observe"
]);
var LIVE_ALLOWLIST = new Set([
  "session.start",
  "session.end",
  "generation.end",
  "tool.fail",
  "shell.end",
  "subagent.start",
  "subagent.end",
  "gate.outcome",
  "cost.turn",
  "cost.session_alert",
  "ship.claim",
  "policy.deny",
  "compact",
  "prompt.submit"
]);

// src/core/policy/policy.defaults.ts
var DEFAULT_LESSONS_POLICY = {
  enabled: false,
  maxInjectSession: 5,
  maxInjectRetry: 8,
  maxCharsSession: 900,
  maxCharsRetry: 1400,
  promoteHitCount: 2,
  decayLambda: 0.02,
  projectBoost: 1.5,
  syncRulesFile: "auto",
  gardenOnSessionEnd: true
};
var DEFAULTS = {
  version: 1,
  mode: "solo",
  codePaths: ["src", "apps", "libs", "packages"],
  grind: {
    enabled: false,
    maxLoops: 5,
    lintCommand: null,
    testCommand: null,
    appendFiles: "auto"
  },
  shipGate: {
    enabled: false,
    runtimePathPrefixes: ["src", "apps", "libs", "packages", "deploy", "scripts"],
    runtimePathExcludes: [".tlc/", "**/node_modules/", "**/.git/"],
    evidenceDir: null,
    evidenceMaxAgeHours: 48,
    emptyDiffAntiShip: false,
    claimWindowMinutes: 10
  },
  subagents: {
    enforceAllowlist: false,
    requireModel: false,
    allowedModels: [],
    blockedPatterns: ["-fast(?:$|[^a-z0-9])", "/fast(?:$|[^a-z0-9])"],
    minEffort: null,
    blockParentFast: false,
    blockMode: "deny",
    readOnlyTypes: ["explore"]
  },
  docs: {
    command: null,
    severity: "warn"
  },
  observe: {
    enabled: false,
    rails: []
  },
  comments: {
    enabled: false,
    onViolation: "followup",
    mode: "declared"
  },
  obs: {
    globalSpool: false,
    includePayloads: DEFAULT_OBS.includePayloads,
    maxAttrChars: DEFAULT_OBS.maxAttrChars,
    sessionCostAlertUsd: DEFAULT_OBS.sessionCostAlertUsd,
    retentionDays: DEFAULT_OBS.retentionDays
  },
  untrustedContent: {
    enabled: false,
    extraTools: [],
    extraCommandPatterns: []
  },
  planGate: {
    enabled: false,
    windowMinutes: 120
  },
  shell: {
    catastrophicAsk: true,
    stallDetection: false,
    stallRepeatThreshold: 3
  },
  intelligence: {
    gapFeedback: true,
    failureClassification: true,
    progressiveHandoff: true,
    progressiveContext: true,
    autopilot: true,
    idleTurnGate: false,
    budgetContinue: false,
    budgetContinueAfterLoops: 3,
    lessons: { ...DEFAULT_LESSONS_POLICY }
  },
  mcpPrime: [],
  bootstrapExtra: []
};

// src/platform/style.ts
var COLORS = {
  structure: "#3d3a4a",
  accent: "#a78bfa",
  success: "#6ee7b7",
  warning: "#d4a574",
  error: "#f87171",
  info: "#93c5fd",
  textMain: "#f5f5f7",
  textMuted: "#9ca3af",
  textDim: "#6b7280"
};
var SYMBOLS = {
  check: "✔",
  cross: "✖",
  warning: "⚠",
  arrow: "→",
  arrowRight: "▸",
  dot: "•",
  bar: "│",
  rule: "══",
  dash: "──"
};
function rgb(hex) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) {
    return "255;255;255";
  }
  return [match[1], match[2], match[3]].map((part) => Number.parseInt(part, 16)).join(";");
}
var ESC = String.fromCharCode(27);
var RESET = `${ESC}[0m`;
function colorEnabled(env = process.env, argv = process.argv, isTty = process.stdout.isTTY === true) {
  if ("NO_COLOR" in env) {
    return false;
  }
  if (argv.includes("--no-color")) {
    return false;
  }
  return isTty;
}
var STATUS_COLOR = {
  ok: "success",
  warn: "warning",
  fail: "error",
  info: "info"
};
var STATUS_MARK = {
  ok: SYMBOLS.check,
  warn: SYMBOLS.warning,
  fail: SYMBOLS.cross,
  info: SYMBOLS.arrowRight
};
var KV_WIDTH = 16;
function createStyle(enabled = colorEnabled()) {
  const wrap = (code, text) => enabled ? `${ESC}[${code}m${text}${RESET}` : text;
  const paint = (name, text) => wrap(`38;2;${rgb(COLORS[name])}`, text);
  return {
    enabled,
    paint,
    bold: (text) => wrap("1", text),
    dim: (text) => paint("textDim", text),
    heading: (text) => paint("accent", `${SYMBOLS.rule} ${text} ${SYMBOLS.rule}`),
    footer: (text) => paint("textDim", `${SYMBOLS.dash} ${text} ${SYMBOLS.dash}`),
    kv: (label, value, width = KV_WIDTH) => `  ${paint("textMuted", `${label}:`.padEnd(width))} ${value}`,
    status: (level, text) => `${paint(STATUS_COLOR[level], STATUS_MARK[level])} ${text}`
  };
}
var PLAIN = createStyle(false);

// src/platform/screen.ts
function render(screen, style) {
  const out = [style.heading(screen.title.toUpperCase())];
  if (screen.summary && screen.summary.length > 0) {
    out.push(`   ${screen.summary.join(style.dim(` ${SYMBOLS.bar} `))}`);
  }
  const width = Math.max(KV_WIDTH, ...screen.sections.flatMap((section) => (section.rows ?? []).map((row) => row.label.length + 1)));
  for (const section of screen.sections) {
    out.push("");
    if (section.title) {
      out.push(style.paint("accent", section.title));
    }
    for (const row of section.rows ?? []) {
      const value = row.level ? style.status(row.level, row.value) : row.value;
      out.push(style.kv(row.label, value, width));
    }
    for (const line of section.lines ?? []) {
      out.push(line === "" ? "" : `  ${line}`);
    }
  }
  if (screen.footer) {
    out.push("", style.footer(screen.footer));
  }
  return out.join(`
`);
}

// tools/init-project.ts
class UsageError extends Error {
}
function parseFlags(args) {
  return {
    dryRun: args.includes("--dry-run"),
    write: args.includes("--write") || args.includes("--minimal"),
    minimal: args.includes("--minimal"),
    stdinJson: args.includes("--stdin-json"),
    force: args.includes("--force")
  };
}
function usageScreen() {
  return {
    title: "harness init",
    sections: [
      {
        lines: `  tlc harness init --dry-run
  tlc harness init --write [--stdin-json] [--force]
  tlc harness init --minimal

--minimal writes a safe agnostic stub (grind/ship off). Prefer the harness-init skill for full discovery.`.split(`
`)
      }
    ]
  };
}
function usageText(style = PLAIN) {
  return render(usageScreen(), style);
}
function launcherPath(home = runtimeHome()) {
  return join4(home, "bin", "tlc-exec.mjs");
}
function shimCommand(platform = process.platform) {
  if (platform === "win32") {
    return { command: "cmd", argsPrefix: ["/c", "node"] };
  }
  return { command: "node", argsPrefix: [] };
}
var CURSOR_SHIM_SPECS = [
  { hookEvent: "sessionStart", handler: "session-start", timeoutSeconds: 10 },
  { hookEvent: "sessionEnd", handler: "session-end", timeoutSeconds: 10 },
  { hookEvent: "preToolUse", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "beforeShellExecution", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "beforeMCPExecution", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "beforeReadFile", handler: "tool-before", timeoutSeconds: 5 },
  { hookEvent: "subagentStart", handler: "subagent-start", timeoutSeconds: 5 },
  { hookEvent: "stop", handler: "stop", timeoutSeconds: 120, loopLimit: 5 },
  { hookEvent: "afterAgentResponse", handler: "response-after", timeoutSeconds: 5, matcher: "AgentResponse" }
];
var CLAUDE_SHIM_SPECS = [
  { hookEvent: "SessionStart", handler: "session-start", timeoutSeconds: 10 },
  { hookEvent: "SessionEnd", handler: "session-end", timeoutSeconds: 10 },
  { hookEvent: "PreToolUse", handler: "tool-before", timeoutSeconds: 10 },
  { hookEvent: "SubagentStart", handler: "subagent-start", timeoutSeconds: 5 },
  { hookEvent: "Stop", handler: "stop", timeoutSeconds: 120, loopLimit: 5 },
  { hookEvent: "MessageDisplay", handler: "response-after", timeoutSeconds: 5 }
];
function cursorShimEntries(launcher) {
  const { command, argsPrefix } = shimCommand();
  return CURSOR_SHIM_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command,
    args: [...argsPrefix, launcher, "shim", spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
    ...spec.loopLimit !== undefined ? { loopLimit: spec.loopLimit } : {},
    ...spec.matcher !== undefined ? { matcher: spec.matcher } : {}
  }));
}
function claudeShimEntries(launcher) {
  return CLAUDE_SHIM_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command: "node",
    args: [launcher, "shim", spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
    ...spec.loopLimit !== undefined ? { loopLimit: spec.loopLimit } : {}
  }));
}
var GITIGNORE_LINE = ".tlc/harness/state/";
function mergeGitignore(root) {
  const path = join4(root, ".gitignore");
  const existing = existsSync3(path) ? readFileSync3(path, "utf8") : "";
  const lines = existing.split(`
`);
  const alreadyPresent = lines.includes(GITIGNORE_LINE);
  if (alreadyPresent) {
    return { text: existing.endsWith(`
`) || existing === "" ? existing : `${existing}
`, changed: false };
  }
  lines.push(GITIGNORE_LINE);
  const withoutTrailingBlank = lines.filter((line, index, all) => line.length > 0 || index < all.length - 1);
  return { text: `${withoutTrailingBlank.join(`
`).replace(/\n+$/, "")}
`, changed: true };
}
function resolvePolicy(root, flags, stdinText) {
  if (flags.stdinJson && !flags.minimal) {
    if (!stdinText || stdinText.trim() === "") {
      throw new Error("stdin-json: empty stdin");
    }
    return JSON.parse(stdinText);
  }
  if (!flags.minimal && !flags.stdinJson && existsSync3(projectConfigPath(root))) {
    return JSON.parse(readFileSync3(projectConfigPath(root), "utf8"));
  }
  return DEFAULTS;
}
function detectProviders(dirs = {}) {
  return {
    cursor: existsSync3(dirs.cursor ?? cursorConfigDir()),
    claude: existsSync3(dirs.claude ?? claudeConfigDir())
  };
}
function buildPlan(root, flags, stdinText, presence) {
  const policy = resolvePolicy(root, flags, stdinText);
  const launcher = launcherPath();
  return {
    policy,
    cursorHooksDocument: presence.cursor ? renderCursorHooksDocument(cursorShimEntries(launcher)) : null,
    claudeHooksPreview: presence.claude ? claudeShimEntries(launcher) : null,
    gitignoreLine: GITIGNORE_LINE
  };
}
function applyPlan(root, flags, presence, stdinText) {
  const policy = resolvePolicy(root, flags, stdinText);
  const configPath = projectConfigPath(root);
  mkdirSync3(dirname3(configPath), { recursive: true });
  writeFileSync3(configPath, `${JSON.stringify(policy, null, 2)}
`);
  const launcher = launcherPath();
  const cursor = presence.cursor ? (() => {
    const result = applyCursorWiring({
      target: join4(root, ".cursor", "hooks.json"),
      strategy: "replace",
      entries: cursorShimEntries(launcher)
    }, { force: flags.force });
    return { skipped: false, status: result.status, target: result.target };
  })() : { skipped: true };
  const claude = presence.claude ? (() => {
    const result = applyClaudeWiring(join4(root, ".claude", "settings.json"), claudeShimEntries(launcher));
    return {
      skipped: false,
      status: result.ok ? result.changed ? "written" : "unchanged" : "failed",
      target: join4(root, ".claude", "settings.json")
    };
  })() : { skipped: true };
  const gitignore = mergeGitignore(root);
  writeFileSync3(join4(root, ".gitignore"), gitignore.text);
  return { configPath, cursor, claude };
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
async function main(argv) {
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
if (__require.main == __require.module) {
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
export {
  usageText,
  usageScreen,
  resolvePolicy,
  parseFlags,
  mergeGitignore,
  main,
  launcherPath,
  detectProviders,
  cursorShimEntries,
  claudeShimEntries,
  buildPlan,
  applyPlan,
  UsageError,
  GITIGNORE_LINE
};
