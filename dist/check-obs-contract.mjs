import { createRequire } from "node:module";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/core/observability/observability.types.ts
var exports_observability_types = {};
__export(exports_observability_types, {
  resolveObsLevel: () => resolveObsLevel,
  redactDeep: () => redactDeep,
  SIGNAL_KINDS: () => SIGNAL_KINDS,
  LIVE_ALLOWLIST: () => LIVE_ALLOWLIST,
  EVENT_KIND_TO_OBS_KIND: () => EVENT_KIND_TO_OBS_KIND,
  DEFAULT_OBS: () => DEFAULT_OBS
});
function resolveObsLevel(kind, attrs = {}, forceDebug = false) {
  if (forceDebug) {
    return "debug";
  }
  if (kind === "shell.end" || kind === "shell.start") {
    const permission = String(attrs.permission ?? "allow");
    return permission === "allow" ? "debug" : "signal";
  }
  if (kind === "mcp.end") {
    const outcome = String(attrs.outcome ?? attrs.status ?? "success");
    return outcome === "error" || outcome === "fail" || outcome === "denied" ? "signal" : "debug";
  }
  return SIGNAL_KINDS.has(kind) ? "signal" : "debug";
}
function redactDeep(value) {
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactDeep(nested);
    }
    return out;
  }
  return value;
}
var DEFAULT_OBS, SIGNAL_KINDS, LIVE_ALLOWLIST, EVENT_KIND_TO_OBS_KIND, SECRET_KEY, SECRET_VALUE;
var init_observability_types = __esm(() => {
  DEFAULT_OBS = {
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
  SIGNAL_KINDS = new Set([
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
  LIVE_ALLOWLIST = new Set([
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
  EVENT_KIND_TO_OBS_KIND = {
    "session.start": "session.start",
    "session.end": "session.end",
    "prompt.submit": "prompt.submit",
    "tool.before": "tool.start",
    "tool.after": "tool.end",
    "tool.failure": "tool.fail",
    "shell.before": "shell.start",
    "shell.after": "shell.end",
    "mcp.before": "mcp.start",
    "mcp.after": "mcp.end",
    "read.before": "file.read",
    "edit.after": "file.edit",
    "subagent.start": "subagent.start",
    "subagent.stop": "subagent.end",
    stop: "generation.end",
    "compact.before": "compact",
    "response.after": "agent.response",
    "thought.after": "agent.thought"
  };
  SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|credential|private[_-]?key)/i;
  SECRET_VALUE = /\b(ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
});

// tools/check-obs-contract.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/observability/observability.service.ts
init_observability_types();
var PAYLOAD_KEYS = new Set(["tool_input", "tool_output", "prompt", "text", "content", "output"]);
var ROLLUP_KINDS = [
  "agent.response",
  "agent.thought",
  "compact",
  "gate.outcome",
  "mcp.end",
  "mcp.start",
  "policy.deny",
  "prompt.submit",
  "session.start",
  "shell.end",
  "shell.start",
  "subagent.start",
  "tool.end",
  "tool.fail",
  "tool.start"
];

// tools/check-obs-contract.ts
init_observability_types();

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

// src/core/observability/observability.why.ts
var NONE = new Set(["none", "", "undefined"]);
var NOTHING_WAS_THE_HARNESS = [
  "No harness decision in this window.",
  "Whatever you just saw was the model, not a rail — the harness allowed everything it was asked about."
].join(`
`);
var WHY_KINDS = [
  "policy.deny",
  "shell.start",
  "gate.outcome",
  "session.start",
  "policy.observe",
  "cost.session_alert"
];

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
var ACTIVITY_PLANES = ["obs.jsonl", "debug.jsonl"];

// tools/check-obs-contract.ts
var repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
var CONSUMERS = [
  { name: "turn.activity", kinds: [...TOOL_KINDS], planes: [...ACTIVITY_PLANES] },
  { name: "observability.why", kinds: [...WHY_KINDS], planes: [...ACTIVITY_PLANES] },
  { name: "session rollup", kinds: [...ROLLUP_KINDS], planes: "inline" }
];
function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__test__") {
        out.push(...listFiles(full));
      }
      continue;
    }
    if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}
function emittedKinds(root) {
  const sites = new Map;
  for (const kind of Object.values(EVENT_KIND_TO_OBS_KIND)) {
    sites.set(kind, ["EVENT_KIND_TO_OBS_KIND"]);
  }
  for (const dir of ["src/entrypoints", "src/core", "bin", "tools"]) {
    for (const file of listFiles(join(root, dir))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bkind:\s*"([a-z][a-z._]*)"/g)) {
        const kind = match[1];
        const at = relative(root, file);
        const existing = sites.get(kind) ?? [];
        if (!existing.includes(at)) {
          sites.set(kind, [...existing, at]);
        }
      }
    }
  }
  return sites;
}
function planeOf(kind) {
  return resolveObsLevel(kind) === "signal" ? "obs.jsonl" : "debug.jsonl";
}
function check(root, consumers, declared) {
  const emitted = emittedKinds(root);
  const violations = [];
  const consumed = new Set(consumers.flatMap((consumer) => consumer.kinds));
  for (const consumer of consumers) {
    for (const kind of consumer.kinds) {
      if (!emitted.has(kind)) {
        violations.push({
          rule: "consumed-never-emitted",
          detail: `${consumer.name} counts \`${kind}\`, which no producer emits`
        });
        continue;
      }
      if (consumer.planes === "inline") {
        continue;
      }
      const plane = planeOf(kind);
      if (!consumer.planes.includes(plane)) {
        violations.push({
          rule: "plane-mismatch",
          detail: `${consumer.name} counts \`${kind}\`, which lands on ${plane}, but reads only ${[...consumer.planes].join(", ")}`
        });
      }
    }
  }
  const orphans = declared.filter((kind) => emitted.has(kind) && !consumed.has(kind)).sort();
  return { violations, orphans };
}
function report(outcome) {
  const lines = [];
  for (const violation of outcome.violations) {
    lines.push(`  [${violation.rule}]  ${violation.detail}`);
  }
  const ok = outcome.violations.length === 0;
  lines.unshift(ok ? `check-obs-contract: every counted kind is emitted and read on a plane it lands on` : `check-obs-contract: ${outcome.violations.length} contract violation(s)`);
  if (outcome.orphans.length > 0) {
    lines.push(`  emitted and read by no declared consumer: ${outcome.orphans.join(", ")}`);
  }
  return { text: lines.join(`
`), ok };
}
if (__require.main == __require.module) {
  const { SIGNAL_KINDS: SIGNAL_KINDS2 } = await Promise.resolve().then(() => (init_observability_types(), exports_observability_types));
  const declared = [...new Set([...Object.values(EVENT_KIND_TO_OBS_KIND), ...SIGNAL_KINDS2])];
  const outcome = check(repoRoot, CONSUMERS, declared);
  const printed = report(outcome);
  console.log(printed.text);
  process.exit(printed.ok ? 0 : 1);
}
export {
  report,
  planeOf,
  emittedKinds,
  check,
  CONSUMERS
};
