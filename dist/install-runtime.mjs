import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// tools/install-runtime.ts
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join as join2, relative, resolve, sep } from "node:path";

// src/platform/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function conventionalRuntimeHome() {
  return join(homedir(), ".tlc", "harness");
}
function runtimeHome(env = process.env) {
  return env.TLC_HOME ?? conventionalRuntimeHome();
}
function runtimeHomeWasChosen(env = process.env) {
  return env.TLC_HOME_FROM_ENV === "1";
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

// src/core/duplication/duplication.service.ts
var MIN_RUN = 6;

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
var FETCH_VERBS = new Set(["aria2c", "curl", "fetch", "http", "httpie", "https", "wget"]);
var NETWORK_VERBS = new Set([...FETCH_VERBS, "nc", "ncat", "socat", "telnet", "lwp-request"]);

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
  supplyChain: {
    enabled: false
  },
  duplication: {
    enabled: false,
    minRun: MIN_RUN
  },
  obs: {
    globalSpool: false,
    includePayloads: DEFAULT_OBS.includePayloads,
    maxAttrChars: DEFAULT_OBS.maxAttrChars,
    sessionCostAlertUsd: DEFAULT_OBS.sessionCostAlertUsd,
    retentionDays: DEFAULT_OBS.retentionDays
  },
  untrustedContent: {
    mode: "frame",
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
// src/core/supply-chain/supply-chain.service.ts
var UNPINNED_SPECS = new Set(["latest", "*", "x", "X", "", "main", "master", "HEAD"]);

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
  "package.json"
];
var OPERATOR_OWNED = ["config.json", "state", "flags"];
var NOT_SHIPPED = [join2("tools", "dev"), join2("tools", "__test__")];
function isShipped(relativePath) {
  const normalised = relativePath.split(sep).join("/");
  return !NOT_SHIPPED.some((excluded) => {
    const prefix = excluded.split(sep).join("/");
    return normalised === prefix || normalised.startsWith(`${prefix}/`);
  });
}
function originRoot(env = process.env) {
  const declared = env.TLC_ORIGIN?.trim();
  if (declared && declared.length > 0) {
    return resolve(declared);
  }
  const home = env.TLC_HOME?.trim();
  return home && home.length > 0 ? resolve(home) : conventionalRuntimeHome();
}
function installRuntime(source, dest) {
  if (resolve(source) === resolve(dest)) {
    return { kind: "in-place", source, dest, entries: [], missing: [] };
  }
  mkdirSync(dest, { recursive: true });
  const entries = [];
  const missing = [];
  for (const entry of RUNTIME_PAYLOAD) {
    const from = join2(source, entry);
    if (!existsSync(from)) {
      missing.push(entry);
      continue;
    }
    const to = join2(dest, entry);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, {
      recursive: true,
      filter: (src) => isShipped(relative(source, src))
    });
    entries.push(entry);
  }
  writeFileSync(join2(dest, NPM_MARKER), `Installed by \`tlc harness install\` from ${source}.
Update with: npm i -g ${NPM_PACKAGE}@latest && tlc harness install
`, "utf8");
  const config = join2(dest, "config.json");
  const example = join2(dest, "config.example.json");
  if (!existsSync(config) && existsSync(example)) {
    writeFileSync(config, readFileSync(example, "utf8"), "utf8");
  }
  return { kind: "copied", source, dest, entries, missing };
}
function installScreen(report) {
  if (report.kind === "in-place") {
    return {
      title: "harness install",
      sections: [
        { rows: [{ label: "runtime", value: `already at ${report.dest} — nothing to copy`, level: "ok" }] }
      ]
    };
  }
  const rows = [
    { label: "installed", value: `${report.entries.length} path(s) → ${report.dest}`, level: "ok" },
    { label: "from", value: report.source }
  ];
  if (report.missing.length > 0) {
    rows.push({
      label: "packaging",
      value: `MISSING from the source: ${report.missing.join(", ")}`,
      level: "fail"
    });
  }
  return { title: "harness install", sections: [{ rows }] };
}
function installReportText(report, style = PLAIN) {
  return render(installScreen(report), style);
}
function installDest(env = process.env) {
  const explicit = env.TLC_INSTALL_DEST?.trim();
  if (explicit && explicit.length > 0) {
    return resolve(explicit);
  }
  return runtimeHomeWasChosen(env) ? runtimeHome(env) : conventionalRuntimeHome();
}
function fetchPrices(dest, spawn = spawnSync) {
  const result = spawn(process.execPath, [join2(dest, "bin", "tlc-exec.mjs"), "refresh-model-prices"], {
    stdio: "inherit",
    env: { ...process.env, TLC_HOME: dest }
  });
  if ((result.status ?? 1) !== 0) {
    console.log("install: prices not fetched — cost estimates stay empty until `tlc harness prices refresh`");
  }
}
if (__require.main == __require.module) {
  const source = originRoot();
  const dest = installDest();
  const report = installRuntime(source, dest);
  console.log(installReportText(report, createStyle()));
  fetchPrices(dest);
  process.exit(report.missing.length > 0 ? 1 : 0);
}
export {
  originRoot,
  isShipped,
  installScreen,
  installRuntime,
  installReportText,
  installDest,
  fetchPrices,
  RUNTIME_PAYLOAD,
  OPERATOR_OWNED,
  NOT_SHIPPED
};
