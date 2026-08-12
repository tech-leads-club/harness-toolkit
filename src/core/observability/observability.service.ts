import { createHash, randomUUID } from "node:crypto";
import type { HarnessEvent } from "../../contracts/harness-event.ts";
import { appendAuditRecord, appendObsRecord, loadRollup, saveRollup } from "./observability.store.ts";
import {
  DEFAULT_OBS,
  EVENT_KIND_TO_OBS_KIND,
  type ObsEvent,
  type ObservabilityConfig,
  type ObsKind,
  type ObsLevel,
  redactDeep,
  resolveObsLevel,
} from "./observability.types.ts";

export type RecordObsInput = {
  provider: string;
  kind: ObsKind;
  sessionKey?: string;
  model?: string;
  level?: ObsLevel;
  parentSpanId?: string;
  attrs?: Record<string, unknown>;
  gen_ai?: ObsEvent["gen_ai"];
  forceDebug?: boolean;
};

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function deriveTraceId(sessionKey?: string): string {
  const seed = sessionKey || randomUUID();
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function truncateAttrs(attrs: Record<string, unknown>, max: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = typeof v === "string" && v.length > max ? `${v.slice(0, max)}\n…(truncated)` : v;
  }
  return out;
}

const PAYLOAD_KEYS = new Set(["tool_input", "tool_output", "prompt", "text", "content", "output"]);

function stripPayloads(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!PAYLOAD_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

export function recordObs(root: string, config: ObservabilityConfig, input: RecordObsInput): ObsEvent | null {
  if (!config.enabled) {
    return null;
  }

  const level = input.level ?? resolveObsLevel(input.kind, input.attrs ?? {}, !!input.forceDebug);
  if (level === "debug" && !config.debugEnabled && !input.forceDebug) {
    return null;
  }

  let attrs = truncateAttrs(redactDeep(input.attrs ?? {}) as Record<string, unknown>, config.maxAttrChars);
  if (!config.includePayloads) {
    attrs = stripPayloads(attrs);
  }

  const event: ObsEvent = {
    schema: "harness.observability.v1",
    provider: input.provider,
    kind: input.kind,
    level,
    ts: new Date().toISOString(),
    trace_id: deriveTraceId(input.sessionKey),
    span_id: shortId(),
    parent_span_id: input.parentSpanId,
    session_id: input.sessionKey,
    model: input.model,
    attrs,
    gen_ai: input.gen_ai,
  };

  const file = level === "signal" ? config.signalPath : config.debugPath;
  if (!appendObsRecord(root, file, event, config.globalSpool)) {
    return null;
  }

  if (input.sessionKey) {
    updateRollup(root, config, event);
  }

  return event;
}

function updateRollup(root: string, config: ObservabilityConfig, event: ObsEvent): void {
  const sessionKey = event.session_id;
  if (!sessionKey) {
    return;
  }
  const rollup = loadRollup(root, sessionKey, event.provider);

  if (event.model) {
    rollup.models[event.model] = (rollup.models[event.model] ?? 0) + 1;
  }

  if (event.kind === "tool.start" || event.kind === "tool.end" || event.kind === "tool.fail") {
    const name = String(event.attrs.tool_name ?? "unknown");
    const slot = rollup.tools[name] ?? { ok: 0, fail: 0, ms: 0 };
    if (event.kind === "tool.end") {
      slot.ok += 1;
      slot.ms += Number(event.attrs.duration_ms ?? event.gen_ai?.duration_ms ?? 0);
    }
    if (event.kind === "tool.fail") {
      slot.fail += 1;
    }
    rollup.tools[name] = slot;
  }

  if (event.kind === "subagent.start") {
    const type = String(event.attrs.subagent_type ?? "unknown");
    const slot = rollup.subagents[type] ?? { count: 0, models: {} };
    slot.count += 1;
    const m = String(event.attrs.subagent_model ?? event.model ?? "unset");
    slot.models[m] = (slot.models[m] ?? 0) + 1;
    rollup.subagents[type] = slot;
  }

  if (event.kind === "gate.outcome") {
    const passed = Boolean(event.attrs.passed);
    if (passed) {
      rollup.gates.pass += 1;
    } else {
      rollup.gates.fail += 1;
    }
    // hazard: a rollup written by an older build has neither map, and incrementing into `undefined` would throw
    // on the path that must never break a turn.
    const name = String(event.attrs.gate ?? "unknown");
    const byName = rollup.gatesByName ?? {};
    const slot = byName[name] ?? { pass: 0, fail: 0 };
    if (passed) {
      slot.pass += 1;
    } else {
      slot.fail += 1;
    }
    byName[name] = slot;
    rollup.gatesByName = byName;

    const ms = Number(event.attrs.duration_ms ?? 0);
    const timing = rollup.gateTime ?? {};
    const cell = timing[name] ?? { runs: 0, totalMs: 0, worstMs: 0, reused: 0 };
    // invariant: a reused verdict is counted apart and adds no time. Counting it as a run would divide the total
    // by a larger number and make the command look faster than it is ([/decisions/ad-045.md](/decisions/ad-045.md)).
    if (event.attrs.reused === true) {
      cell.reused = (cell.reused ?? 0) + 1;
    } else {
      cell.runs += 1;
      cell.totalMs += ms;
      cell.worstMs = Math.max(cell.worstMs, ms);
    }
    timing[name] = cell;
    rollup.gateTime = timing;
  }
  if (event.kind === "policy.deny") {
    rollup.denials += 1;
  }
  if (event.kind === "session.start" && typeof event.attrs.injected_chars === "number") {
    rollup.injected_chars = event.attrs.injected_chars;
  }
  if (event.kind === "session.start" && typeof event.attrs.durable_chars === "number") {
    rollup.durable_chars = event.attrs.durable_chars;
  }
  if (event.kind === "session.start" && typeof event.attrs.hook_context_reliable === "boolean") {
    rollup.hook_context_reliable = event.attrs.hook_context_reliable;
  }
  // invariant: one place counts refusals by rule, whichever rail produced them. Two counters for one fact is how
  // they come to disagree.
  if (event.kind === "policy.deny" || event.kind === "shell.start" || event.kind === "shell.end") {
    const permission = String(event.attrs.permission ?? "");
    if (permission === "ask" || permission === "deny") {
      const rule = String(event.attrs.rule ?? "none");
      const byRule = rollup.railsByRule ?? {};
      byRule[rule] = (byRule[rule] ?? 0) + 1;
      rollup.railsByRule = byRule;
    }
  }
  if (event.kind === "prompt.submit") {
    rollup.prompts += 1;
  }
  if (event.kind === "agent.response") {
    rollup.responses += 1;
  }
  if (event.kind === "agent.thought") {
    rollup.thoughts += 1;
  }
  if (event.kind === "compact") {
    rollup.comped += 1;
  }

  if (event.kind === "shell.end" || event.kind === "shell.start") {
    const perm = String(event.attrs.permission ?? "");
    if (perm === "ask") {
      rollup.shell.ask += 1;
    } else if (perm === "deny") {
      rollup.shell.deny += 1;
    } else if (event.kind === "shell.end") {
      rollup.shell.allow += 1;
    }
    // hazard: a rollup written by an older build has no `byRule`, and incrementing into `undefined` would throw
    // inside the one path that must never break a turn.
    if (perm === "ask" || perm === "deny") {
      const rule = String(event.attrs.rule ?? "none");
      const byRule = rollup.shell.byRule ?? {};
      byRule[rule] = (byRule[rule] ?? 0) + 1;
      rollup.shell.byRule = byRule;
    }
  }

  if (event.kind === "mcp.end" || event.kind === "mcp.start") {
    const tool = String(event.attrs.tool_name ?? "unknown");
    rollup.mcp[tool] = (rollup.mcp[tool] ?? 0) + 1;
  }

  /**
   * hazard: this added each reading to a running total, and the reading is not a delta. The transcript reader sums
   * the tail of the transcript, so every value is a snapshot of a sliding window, and it is attached to every tool
   * event. Summing 3,488 snapshots reported 102.7M output tokens against 559k input — a number nobody can act on
   * ([/decisions/ad-064.md](/decisions/ad-064.md)).
   *
   * invariant: the latest reading replaces the previous one. A snapshot is assigned, never accumulated.
   */
  const inTok = event.gen_ai?.input_tokens ?? 0;
  const outTok = event.gen_ai?.output_tokens ?? 0;
  if (inTok || outTok) {
    rollup.input_tokens = inTok;
    rollup.output_tokens = outTok;
    const cost = event.gen_ai?.cost_usd;
    if (typeof cost === "number") {
      rollup.estimated_cost_usd = cost;
    } else if (event.gen_ai?.cost_source === "missing") {
      rollup.cost_incomplete = true;
    }
  }

  if (
    config.sessionCostAlertUsd != null &&
    !rollup.cost_alert_sent &&
    rollup.estimated_cost_usd >= config.sessionCostAlertUsd
  ) {
    rollup.cost_alert_sent = true;
    saveRollup(root, rollup);
    recordObs(root, config, {
      provider: event.provider,
      kind: "cost.session_alert",
      sessionKey,
      attrs: {
        session_cost_usd: rollup.estimated_cost_usd,
        threshold_usd: config.sessionCostAlertUsd,
        cost_incomplete: rollup.cost_incomplete,
      },
    });
    return;
  }

  saveRollup(root, rollup);
}

export function recordAudit(root: string, event: string, payload: unknown, spool = false): void {
  appendAuditRecord(
    root,
    {
      ts: new Date().toISOString(),
      event,
      payload: redactDeep(payload),
    },
    spool,
  );
}

export function recordFromEvent(
  root: string,
  config: ObservabilityConfig,
  event: HarnessEvent,
  extra: { gen_ai?: ObsEvent["gen_ai"]; forceDebug?: boolean } = {},
): ObsEvent | null {
  const kind = EVENT_KIND_TO_OBS_KIND[event.event];
  return recordObs(root, config, {
    provider: event.provider,
    kind,
    sessionKey: event.sessionKey,
    model: event.model,
    forceDebug: extra.forceDebug,
    gen_ai: extra.gen_ai,
    attrs: {
      tool_name: event.toolName,
      command: event.command,
      file_path: event.filePath,
      subagent_type: event.subagentType,
      status: event.status,
      context_usage_percent: event.contextUsagePercent,
      text_chars: typeof event.text === "string" ? event.text.length : undefined,
    },
  });
}

export { DEFAULT_OBS };

// invariant: what `recordRollup` branches on. Fed inline at record time, so it sees every event before plane
// routing — which is why the contract marks it `inline` rather than naming planes.
export const ROLLUP_KINDS = [
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
  "tool.start",
] as const;
