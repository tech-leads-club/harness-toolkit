import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// tools/uninstall-runtime.ts
import {
  existsSync as existsSync2,
  lstatSync,
  readFileSync as readFileSync2,
  readlinkSync,
  realpathSync as realpathSync2,
  rmSync,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname, isAbsolute, join as join2, resolve } from "node:path";

// src/platform/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function conventionalRuntimeHome() {
  return join(homedir(), ".tlc", "harness");
}
function runtimeHome(env = process.env) {
  return env.TLC_HOME ?? conventionalRuntimeHome();
}
function claudeConfigDir() {
  const custom = process.env.CLAUDE_CONFIG_DIR?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), ".claude");
}
function cursorConfigDir() {
  const custom = process.env.CURSOR_CONFIG_DIR?.trim();
  return custom && custom.length > 0 ? custom : join(homedir(), ".cursor");
}

// src/platform/fs-atomic.ts
var RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

// src/core/comment-policy/comment-syntax.catalog.ts
var COMMENT_SYNTAX = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "python",
    extensions: [".py", ".pyi", ".pyw"],
    line: ["#"],
    block: [
      ['"""', '"""'],
      ["'''", "'''"]
    ],
    middle: []
  },
  {
    id: "ruby",
    extensions: [".rb", ".rake", ".gemspec"],
    line: ["#"],
    block: [["=begin", "=end"]],
    middle: []
  },
  {
    id: "shell",
    extensions: [".sh", ".bash", ".zsh", ".ksh", ".fish"],
    line: ["#"],
    block: [],
    middle: []
  },
  {
    id: "go",
    extensions: [".go"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "rust",
    extensions: [".rs"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "java",
    extensions: [".java"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "kotlin",
    extensions: [".kt", ".kts"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "swift",
    extensions: [".swift"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "c",
    extensions: [".c", ".h"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "cpp",
    extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "csharp",
    extensions: [".cs"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "php",
    extensions: [".php"],
    line: ["//", "#"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "scala",
    extensions: [".scala", ".sc"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "dart",
    extensions: [".dart"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "elixir",
    extensions: [".ex", ".exs"],
    line: ["#"],
    block: [],
    middle: []
  },
  {
    id: "erlang",
    extensions: [".erl", ".hrl"],
    line: ["%"],
    block: [],
    middle: []
  },
  {
    id: "haskell",
    extensions: [".hs"],
    line: ["--"],
    block: [["{-", "-}"]],
    middle: []
  },
  {
    id: "lua",
    extensions: [".lua"],
    line: ["--"],
    block: [["--[[", "]]"]],
    middle: []
  },
  {
    id: "sql",
    extensions: [".sql"],
    line: ["--"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "css",
    extensions: [".css", ".scss", ".sass", ".less"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "yaml",
    extensions: [".yaml", ".yml"],
    line: ["#"],
    block: [],
    middle: []
  },
  {
    id: "toml",
    extensions: [".toml"],
    line: ["#"],
    block: [],
    middle: []
  },
  {
    id: "ini",
    extensions: [".ini", ".cfg", ".conf", ".properties"],
    line: [";", "#"],
    block: [],
    middle: []
  },
  {
    id: "dockerfile",
    extensions: [".dockerfile", "dockerfile"],
    line: ["#"],
    block: [],
    middle: []
  },
  {
    id: "makefile",
    extensions: [".mk", "makefile"],
    line: ["#"],
    block: [],
    middle: []
  },
  {
    id: "terraform",
    extensions: [".tf", ".tfvars"],
    line: ["#", "//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "powershell",
    extensions: [".ps1", ".psm1", ".psd1"],
    line: ["#"],
    block: [["<#", "#>"]],
    middle: []
  },
  {
    id: "perl",
    extensions: [".pl", ".pm"],
    line: ["#"],
    block: [],
    middle: []
  },
  {
    id: "r",
    extensions: [".r"],
    line: ["#"],
    block: [],
    middle: []
  },
  {
    id: "julia",
    extensions: [".jl"],
    line: ["#"],
    block: [["#=", "=#"]],
    middle: []
  },
  {
    id: "vue",
    extensions: [".vue", ".svelte"],
    line: ["//"],
    block: [
      ["/*", "*/"],
      ["<!--", "-->"]
    ],
    middle: ["*"]
  },
  {
    id: "html",
    extensions: [".html", ".htm", ".xml", ".xhtml"],
    line: [],
    block: [["<!--", "-->"]],
    middle: []
  },
  {
    id: "graphql",
    extensions: [".graphql", ".gql"],
    line: ["#"],
    block: [],
    middle: []
  },
  {
    id: "protobuf",
    extensions: [".proto"],
    line: ["//"],
    block: [["/*", "*/"]],
    middle: ["*"]
  },
  {
    id: "zig",
    extensions: [".zig"],
    line: ["//"],
    block: [],
    middle: []
  },
  {
    id: "clojure",
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    line: [";"],
    block: [],
    middle: []
  },
  {
    id: "ocaml",
    extensions: [".ml", ".mli"],
    line: [],
    block: [["(*", "*)"]],
    middle: ["*"]
  },
  {
    id: "fsharp",
    extensions: [".fs", ".fsi", ".fsx"],
    line: ["//"],
    block: [["(*", "*)"]],
    middle: ["*"]
  },
  {
    id: "vim",
    extensions: [".vim"],
    line: ['"'],
    block: [],
    middle: []
  },
  {
    id: "tex",
    extensions: [".tex", ".sty", ".cls"],
    line: ["%"],
    block: [],
    middle: []
  }
];

// src/core/comment-policy/comment-syntax.store.ts
function buildIndex(entries) {
  const byKey = new Map;
  for (const entry of entries) {
    const syntax = { line: entry.line, block: entry.block, middle: entry.middle };
    for (const extension of entry.extensions) {
      byKey.set(extension.toLowerCase(), syntax);
    }
  }
  return byKey;
}
var INDEX = buildIndex(COMMENT_SYNTAX);
var KNOWN_EXTENSION_COUNT = INDEX.size;

// src/core/comment-policy/comment-policy.service.ts
var STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "get",
  "gets",
  "has",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "return",
  "returns",
  "set",
  "sets",
  "that",
  "the",
  "then",
  "this",
  "to",
  "true",
  "when",
  "which",
  "with"
]);

// src/core/floor/floor.paths.ts
var SECRET_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pgpass",
  "credentials",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa"
]);

// src/core/floor/floor.tokenize.ts
var SEPARATORS = new Set([";", "|", "&", `
`]);
var ESCAPABLE = new Set([" ", "\t", '"', "'", "$", "`", "\\", ";", "|", "&", "(", ")"]);

// src/core/floor/floor.verb.ts
var WRAPPERS = new Set(["command", "doas", "env", "nice", "nohup", "sudo", "time", "xargs"]);

// src/core/floor/floor.policy-surface.ts
var PROVEN_READERS = new Set([
  "cat",
  "cmp",
  "diff",
  "echo",
  "file",
  "grep",
  "head",
  "jq",
  "less",
  "ls",
  "md5sum",
  "more",
  "od",
  "printf",
  "rg",
  "sha256sum",
  "stat",
  "strings",
  "tail",
  "test",
  "[",
  "wc",
  "xxd"
]);
var GIT_READERS = new Set(["show", "diff", "log", "status", "ls-files", "cat-file", "blame"]);
var EXECUTES_STDIN = new Set([
  "ash",
  "awk",
  "bash",
  "bun",
  "dash",
  "deno",
  "ed",
  "ex",
  "fish",
  "gawk",
  "ksh",
  "lua",
  "node",
  "perl",
  "php",
  "python",
  "python2",
  "python3",
  "ruby",
  "sed",
  "sh",
  "tclsh",
  "zsh"
]);
var HARNESS_BINS = new Set(["tlc", "tlc.cmd"]);
var MUTATING_SUBCOMMANDS = new Set(["pause", "resume", "grind", "mode", "init", "gate", "policy"]);

// src/core/floor/floor.service.ts
var DESTRUCTIVE_VERBS = new Set(["dd", "rm", "rmdir", "shred", "truncate"]);
var MACHINE_VERBS = new Set(["halt", "poweroff", "reboot", "shutdown"]);
var READER_VERBS = new Set(["base64", "cat", "head", "less", "more", "od", "strings", "tail", "xxd"]);
var READING_TOOLS = new Set(["Read", "Edit", "MultiEdit", "NotebookEdit"]);
var EXPANDING_VERBS = new Set([".", "eval", "source"]);
var SHELLS = new Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"]);

// src/core/gate/gate.findings.ts
var SOURCE_EXT = "ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|swift|php|sh|sql";
var PATH_IN_OUTPUT = new RegExp(`(?:file://)?((?:[A-Za-z]:)?[\\w./~@+-]*[\\w-]\\.(?:${SOURCE_EXT}))(?=[:)\\s,'"\`]|$)`, "g");

// src/core/gate/gate.command.ts
var RECIPE_RUNNERS = new Set(["just", "make", "task", "mise", "rake"]);
var SCRIPT_RUNNERS = new Set(["npm", "yarn", "pnpm"]);
var TRANSPARENT_PREFIXES = new Set(["npx", "bunx", "dlx", "exec"]);

// src/core/gate/gate.lock.ts
var GATE_LOCK_STALE_MS = 30 * 60 * 1000;

// src/core/lesson/lesson.store.ts
var EPOCH = "1970-01-01T00:00:00.000Z";
function coreLesson(input) {
  return {
    ...input,
    scope: "gate-execution",
    source: "core",
    tier: "core",
    status: "active",
    confidence: 1,
    hitCount: 1,
    pinned: false,
    refs: [],
    sessionKeys: [],
    injectedCount: 0,
    gradeableCount: 0,
    helpedCount: 0,
    neutralCount: 0,
    firstSeenAt: EPOCH,
    lastSeenAt: EPOCH,
    lastAccessedAt: EPOCH,
    updatedAt: EPOCH
  };
}
var CORE_LESSONS = [
  coreLesson({
    id: "core:gate:lint",
    failedGate: "lint",
    category: "verification",
    triggerTokens: ["lint", "biome", "eslint", "ruff", "format"],
    instruction: "A lint gate failure means changed files still violate the project lint command. Fix the reported findings without suppressions.",
    avoid: "Do not add lint suppressions, disable comments, or delete failing files to silence the gate.",
    prefer: "Apply the smallest fix that clears each finding, then let the stop hook re-check.",
    preRetryCheck: "Confirm the lint command targets only the intended changed files and still fails for the same codes.",
    priority: 90
  }),
  coreLesson({
    id: "core:gate:test",
    failedGate: "test",
    category: "verification",
    triggerTokens: ["test", "vitest", "jest", "pytest", "failing"],
    instruction: "A test gate failure means assertions still fail. Fix the behavior or the test under the real contract — do not delete or skip tests.",
    avoid: "Do not delete failing tests, mark them skipped, or weaken assertions to force green.",
    prefer: "Reproduce the failure, fix root cause, re-run the same test target.",
    preRetryCheck: "Identify the failing test name/file from the gate output before editing.",
    priority: 90
  }),
  coreLesson({
    id: "core:gate:comments",
    failedGate: "comments",
    category: "verification",
    triggerTokens: ["junk comment", "TODO", "FIXME", "banner"],
    instruction: "Junk-comment policy failed. Delete narrating comments, banners, TODO/FIXME, and commented-out code.",
    avoid: "Do not keep TODO markers or section banners 'for clarity'.",
    prefer: "Keep only comments that explain a non-obvious why (invariant, hazard, external constraint).",
    preRetryCheck: "Scan the listed file:line hits and remove each one.",
    priority: 80
  }),
  coreLesson({
    id: "core:gate:ship",
    failedGate: "ship",
    category: "ship-evidence",
    triggerTokens: ["ship", "evidence", "90-verdict", "PASS"],
    instruction: "Ship claim without recent production PASS evidence. Produce real evidence before claiming done.",
    avoid: "Do not claim shipped based on unit tests alone when runtime paths changed.",
    prefer: "Run production E2E, write 90-verdict.txt PASS, cite the evidence path.",
    preRetryCheck: "Confirm evidenceDir and a recent PASS verdict exist for this change.",
    priority: 95
  }),
  coreLesson({
    id: "core:gate:empty-diff",
    failedGate: "empty-diff",
    category: "ship-evidence",
    triggerTokens: ["empty", "diff", "no changes", "shipped"],
    instruction: "Done/shipped was claimed with zero file changes. Either implement the work or explain why zero-diff is correct — do not claim shipped on an empty tree.",
    avoid: "Do not restate 'done' without a real diff or an explicit zero-change justification.",
    prefer: "Make the missing change, or clearly document why no files should change.",
    preRetryCheck: "Inspect git status / changed files before the next stop.",
    priority: 92
  }),
  coreLesson({
    id: "core:gate:stagnation",
    failedGate: "stagnation",
    category: "stagnation",
    triggerTokens: ["stagnation", "identical", "fingerprint", "same fail"],
    instruction: "Identical validation fingerprint repeated. Change approach — do not re-apply the same failing edit.",
    avoid: "Do not retry the exact same patch, command, or suppression.",
    prefer: "Diagnose root cause with a different path, or escalate with BLOCKED / TRIED / NEED.",
    preRetryCheck: "Diff your last edit against the gate output; ensure the next action is different.",
    priority: 100
  })
];

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

// src/core/observability/observability.report.ts
var SHELL_TOOLS = new Set(["Bash", "run_terminal_cmd", "terminal"]);

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

// src/core/observability/observability.service.ts
var PAYLOAD_KEYS = new Set(["tool_input", "tool_output", "prompt", "text", "content", "output"]);

// src/core/observability/observability.why.ts
var NONE = new Set(["none", "", "undefined"]);
var NOTHING_WAS_THE_HARNESS = [
  "No harness decision in this window.",
  "Whatever you just saw was the model, not a rail — the harness allowed everything it was asked about."
].join(`
`);

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

// src/core/policy/policy.guard.ts
var WRITE_TOOLS = new Set(["Edit", "Write", "Delete", "MultiEdit", "NotebookEdit"]);

// src/core/presence/presence.service.ts
var STALE_MS = 10 * 60 * 1000;

// src/core/shell-policy/shell-policy.service.ts
var WRAPPERS2 = new Set(["command", "doas", "env", "nice", "nohup", "sudo", "time", "xargs"]);
var MACHINE = new Set(["halt", "poweroff", "reboot", "shutdown"]);
var NETWORK = new Set(["curl", "ftp", "gh", "nc", "ncat", "rsync", "scp", "sftp", "ssh", "telnet", "wget"]);
var WRITE = new Set(["cp", "mv", "rm", "rmdir", "tee", "truncate"]);
var PRIVILEGE = new Set(["chmod", "chown"]);
var PAIRED_ASK = new Set(["write", "privilege", "network"]);
// src/core/turn/turn.activity.ts
var TOOL_KINDS = new Set([
  "tool.start",
  "tool.end",
  "tool.fail",
  "shell.start",
  "shell.end",
  "mcp.start",
  "mcp.end",
  "file.edit",
  "file.read"
]);
// bin/tlc-cli.ts
var NPM_PACKAGE = "@tech-leads-club/harness-toolkit";
var NPM_MARKER = "installed-from-npm";
if (false) {}

// src/providers/claude/claude.wiring.ts
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isHooksRecord(value) {
  return isPlainRecord(value);
}
var LAUNCHER_MARKER = "tlc-exec.mjs";
function isHarnessGroup(group) {
  return JSON.stringify(group ?? null).includes(LAUNCHER_MARKER);
}
function unmergeClaudeSettings(existingText) {
  if (existingText === null || existingText.trim() === "") {
    return { ok: true, settingsText: "", changed: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(existingText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, block: "" };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, error: "settings.json root is not a JSON object", block: "" };
  }
  const currentHooks = isHooksRecord(parsed.hooks) ? parsed.hooks : {};
  const remainingHooks = {};
  let changed = false;
  for (const [hookEvent, groups] of Object.entries(currentHooks)) {
    const foreign = groups.filter((group) => !isHarnessGroup(group));
    if (foreign.length !== groups.length) {
      changed = true;
    }
    if (foreign.length > 0) {
      remainingHooks[hookEvent] = foreign;
    }
  }
  const next = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "hooks") {
      next[key] = value;
    } else if (Object.keys(remainingHooks).length > 0) {
      next.hooks = remainingHooks;
    }
  }
  return { ok: true, settingsText: JSON.stringify(next, null, 2), changed };
}
function removeClaudeWiring(settingsPath) {
  if (!existsSync(settingsPath)) {
    return { ok: true, settingsText: "", changed: false };
  }
  const result = unmergeClaudeSettings(readFileSync(settingsPath, "utf8"));
  if (result.ok && result.changed) {
    writeFileSync(settingsPath, result.settingsText, "utf8");
  }
  return result;
}

// src/providers/cursor/cursor.wiring.ts
function unwireCursorHooks(text, marker = "tlc-exec.mjs") {
  if (text === null || text.trim() === "") {
    return { kind: "absent" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unparsed" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unparsed" };
  }
  const document = parsed;
  const hooks = document.hooks !== null && typeof document.hooks === "object" && !Array.isArray(document.hooks) ? document.hooks : {};
  const remaining = {};
  let removed = 0;
  let kept = 0;
  for (const [hookEvent, value] of Object.entries(hooks)) {
    const list = Array.isArray(value) ? value : [];
    const foreign = list.filter((row) => !JSON.stringify(row ?? null).includes(marker));
    removed += list.length - foreign.length;
    if (foreign.length > 0) {
      remaining[hookEvent] = foreign;
      kept += foreign.length;
    }
  }
  if (kept === 0) {
    return { kind: "empty", removed };
  }
  return {
    kind: "rewritten",
    removed,
    text: `${JSON.stringify({ ...document, hooks: remaining }, null, 2)}
`
  };
}

// tools/install-runtime.ts
var RUNTIME_PAYLOAD = [
  "bin",
  "capabilities",
  "dist",
  "docs",
  "skills",
  "src",
  "tools",
  "config.example.json",
  "model-aliases.json",
  "model-prices.cursor.json",
  "model-prices.json",
  "package.json"
];
var OPERATOR_OWNED = ["config.json", "state", "flags"];
if (false) {}

// tools/uninstall-runtime.ts
function uninstallTargets(env = process.env) {
  const home = runtimeHome(env);
  const binDir = env.TLC_BIN_DIR?.trim() || join2(env.HOME ?? "", ".local", "bin");
  return {
    home,
    binLink: join2(binDir, "tlc"),
    claudeSettings: join2(claudeConfigDir(), "settings.json"),
    cursorHooks: join2(cursorConfigDir(), "hooks.json"),
    skillLinks: [
      join2(claudeConfigDir(), "skills", "harness-init"),
      join2(cursorConfigDir(), "skills", "harness-init")
    ]
  };
}
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function resolveLink(path) {
  try {
    return realpathSync2(path);
  } catch {
    try {
      const target = readlinkSync(path);
      return isAbsolute(target) ? target : resolve(dirname(path), target);
    } catch {
      return path;
    }
  }
}
function canonical(path) {
  try {
    return realpathSync2(path);
  } catch {
    return resolve(path);
  }
}
function pointsInto(link, home) {
  const target = resolveLink(link);
  const root = canonical(home);
  return target === root || target.startsWith(`${root}/`);
}
function planLink(items, path, home, label, ownership) {
  if (!existsSync2(path) && !isSymlink(path)) {
    return;
  }
  if (!isSymlink(path)) {
    items.push({
      action: "keep",
      target: path,
      detail: `${label} is a real file, not a link the installer made`
    });
    return;
  }
  if (ownership === "target" && !pointsInto(path, home)) {
    items.push({ action: "keep", target: path, detail: `points at ${resolveLink(path)} — not ours` });
    return;
  }
  const stale = ownership === "location" && !pointsInto(path, home);
  items.push({
    action: "unlink",
    target: path,
    detail: stale ? `${label}, stale — points at ${resolveLink(path)}` : label
  });
}
function planClaude(items, settingsPath) {
  if (!existsSync2(settingsPath)) {
    return;
  }
  const result = unmergeClaudeSettings(readFileSync2(settingsPath, "utf8"));
  if (!result.ok) {
    items.push({
      action: "keep",
      target: settingsPath,
      detail: `left untouched — it does not parse as JSON: ${result.error}`
    });
    return;
  }
  if (!result.changed) {
    return;
  }
  items.push({
    action: "unmerge",
    target: settingsPath,
    detail: "drop the harness hook groups, keep every other key and every foreign hook"
  });
}
function planCursor(items, hooksPath) {
  const text = existsSync2(hooksPath) ? readFileSync2(hooksPath, "utf8") : null;
  const result = unwireCursorHooks(text);
  switch (result.kind) {
    case "absent":
      return;
    case "unparsed":
      items.push({ action: "keep", target: hooksPath, detail: "left untouched — it does not parse as JSON" });
      return;
    case "empty":
      if (result.removed > 0) {
        items.push({ action: "remove", target: hooksPath, detail: `${result.removed} entries, all ours` });
      }
      return;
    default:
      items.push({
        action: "unmerge",
        target: hooksPath,
        detail: `drop ${result.removed} harness entries, keep the rest`
      });
  }
}
function planRuntime(items, home, purge) {
  const homeIsLink = isSymlink(home);
  if (homeIsLink) {
    items.push({
      action: "unlink",
      target: home,
      detail: `a link to ${resolveLink(home)} — the checkout it points at is left exactly as it is`
    });
    return true;
  }
  if (!existsSync2(home)) {
    return false;
  }
  for (const entry of RUNTIME_PAYLOAD) {
    const path = join2(home, entry);
    if (existsSync2(path)) {
      items.push({ action: "remove", target: path, detail: "runtime payload" });
    }
  }
  const marker = join2(home, NPM_MARKER);
  if (existsSync2(marker)) {
    items.push({ action: "remove", target: marker, detail: "install marker" });
  }
  for (const entry of OPERATOR_OWNED) {
    const path = join2(home, entry);
    if (!existsSync2(path)) {
      continue;
    }
    items.push(purge ? { action: "remove", target: path, detail: "--purge" } : { action: "keep", target: path, detail: "yours — add --purge to remove it" });
  }
  return false;
}
function planManual(items, home) {
  if (existsSync2(join2(home, NPM_MARKER))) {
    items.push({
      action: "manual",
      target: `npm uninstall -g ${NPM_PACKAGE}`,
      detail: "the global package is reported, never removed for you"
    });
  }
  items.push({
    action: "manual",
    target: "rm -rf .tlc/ in each repository",
    detail: "per-project config and state — this command does not search your disk for them"
  });
}
function planUninstall(targets, options = {}) {
  const purge = options.purge === true;
  const items = [];
  planClaude(items, targets.claudeSettings);
  planCursor(items, targets.cursorHooks);
  for (const link of targets.skillLinks) {
    planLink(items, link, targets.home, "skill link", "location");
  }
  planLink(items, targets.binLink, targets.home, "the tlc launcher on PATH", "target");
  const homeIsLink = planRuntime(items, targets.home, purge);
  planManual(items, targets.home);
  return { items, purge, homeIsLink };
}
function pendingItems(plan) {
  return plan.items.filter((item) => item.action === "unmerge" || item.action === "unlink" || item.action === "remove");
}
function applyUninstall(plan, targets) {
  const applied = [];
  const failed = [];
  for (const item of pendingItems(plan)) {
    try {
      if (item.action === "unmerge" && item.target === targets.claudeSettings) {
        removeClaudeWiring(item.target);
      } else if (item.action === "unmerge") {
        const result = unwireCursorHooks(readFileSync2(item.target, "utf8"));
        if (result.kind === "rewritten") {
          writeFileSync2(item.target, result.text, "utf8");
        }
      } else if (item.action === "unlink") {
        unlinkSync(item.target);
      } else {
        rmSync(item.target, { recursive: true, force: true });
      }
      applied.push(item);
    } catch (error) {
      failed.push({ item, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { applied, failed };
}
var ACTION_LEVEL = {
  unmerge: "warn",
  unlink: "warn",
  remove: "warn",
  keep: "ok",
  manual: "info"
};
function uninstallScreen(plan, result) {
  const pending = pendingItems(plan);
  const applied = result !== null;
  if (pending.length === 0) {
    return {
      title: "harness uninstall",
      summary: ["nothing wired"],
      sections: [
        {
          rows: [{ label: "state", value: "no harness artefact found — nothing to undo", level: "ok" }]
        },
        { title: "STILL YOURS TO DO", rows: manualRows(plan) }
      ],
      footer: "already clean · re-run install with the one-liner in the README"
    };
  }
  const changes = pending.map((item) => ({
    label: item.action,
    value: `${item.target} — ${item.detail}`,
    level: ACTION_LEVEL[item.action]
  }));
  const kept = plan.items.filter((item) => item.action === "keep");
  const sections = [
    { title: applied ? "REMOVED" : "WOULD REMOVE", rows: changes },
    ...kept.length > 0 ? [
      {
        title: "KEPT",
        rows: kept.map((item) => ({
          label: "keep",
          value: `${item.target} — ${item.detail}`,
          level: "ok"
        }))
      }
    ] : [],
    { title: "STILL YOURS TO DO", rows: manualRows(plan) },
    ...result !== null && result.failed.length > 0 ? [
      {
        title: "FAILED",
        rows: result.failed.map((entry) => ({
          label: "error",
          value: `${entry.item.target} — ${entry.reason}`,
          level: "fail"
        }))
      }
    ] : []
  ];
  return {
    title: "harness uninstall",
    summary: [
      applied ? `${result.applied.length} applied` : `${pending.length} pending`,
      plan.purge ? "purge: state included" : "purge: state kept",
      plan.homeIsLink ? "runtime: linked checkout, unlinked only" : "runtime: owned by the installer"
    ],
    sections,
    footer: applied ? "reinstall any time with the one-liner in the README" : "nothing was changed · re-run with --yes to apply this plan"
  };
}
function manualRows(plan) {
  return plan.items.filter((item) => item.action === "manual").map((item) => ({ label: "run", value: `${item.target} — ${item.detail}`, level: "info" }));
}
function uninstallReportText(plan, result, style = PLAIN) {
  return render(uninstallScreen(plan, result), style);
}
function main(argv = process.argv.slice(2)) {
  const targets = uninstallTargets();
  const plan = planUninstall(targets, { purge: argv.includes("--purge") });
  const result = argv.includes("--yes") ? applyUninstall(plan, targets) : null;
  console.log(uninstallReportText(plan, result, createStyle()));
  return result !== null && result.failed.length > 0 ? 1 : 0;
}
if (__require.main == __require.module) {
  process.exitCode = main();
}
export {
  uninstallTargets,
  uninstallScreen,
  uninstallReportText,
  planUninstall,
  pendingItems,
  main,
  applyUninstall
};
