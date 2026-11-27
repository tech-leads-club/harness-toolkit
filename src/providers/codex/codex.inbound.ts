import { resolve } from "node:path";
import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";

/** @public Read by tools/dev/render-provider-docs.ts through its dynamic module loader. */
export const EVENT_KIND_BY_HOOK: Record<string, HarnessEventKind> = {
  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "prompt.submit",
  SubagentStart: "subagent.start",
  SubagentStop: "subagent.stop",
  Stop: "stop",
  PreCompact: "compact.before",
};
/** @public Read by tools/dev/render-provider-docs.ts through its dynamic module loader. */
export const PRE_TOOL_USE_FAN_OUT = [
  { match: "Bash", kind: "shell.before" },
  { match: /^mcp__/, kind: "mcp.before" },
] as const;
/** @public Read by tools/dev/render-provider-docs.ts through its dynamic module loader. */
export const POST_TOOL_USE_FAN_OUT = [
  { match: "Bash", kind: "shell.after" },
  { match: /^mcp__/, kind: "mcp.after" },
  { match: "apply_patch", kind: "edit.after" },
] as const;

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function kindFor(hook: string, tool: string | undefined): HarnessEventKind | undefined {
  if (hook !== "PreToolUse" && hook !== "PostToolUse") return EVENT_KIND_BY_HOOK[hook];
  const table = hook === "PreToolUse" ? PRE_TOOL_USE_FAN_OUT : POST_TOOL_USE_FAN_OUT;
  for (const rule of table) {
    if (typeof rule.match === "string" ? tool === rule.match : rule.match.test(tool ?? "")) return rule.kind;
  }
  return hook === "PreToolUse" ? "tool.before" : "tool.after";
}

export function codexToEvent(raw: Record<string, unknown>): HarnessEvent | null {
  const hook = string(raw.hook_event_name);
  const tool = string(raw.tool_name);
  const kind = hook ? kindFor(hook, tool) : undefined;
  if (!kind) return null;
  const input = record(raw.tool_input);
  const cwd = string(raw.cwd) ?? process.cwd();
  const event: HarnessEvent = {
    provider: "codex",
    event: kind,
    sessionKey: `codex-${sanitizeSegment(string(raw.session_id) ?? "default")}`,
    projectDir: cwd,
    cwd,
    raw,
  };
  event.permissionMode = string(raw.permission_mode);
  event.model = string(raw.model);
  event.toolName = tool;
  event.toolInput = input;
  if (kind === "prompt.submit") event.text = string(raw.prompt);
  if (kind === "stop" || kind === "subagent.stop") event.text = string(raw.last_assistant_message);
  if (tool === "Bash") event.command = string(input?.command);
  if (raw.tool_response !== undefined) {
    event.toolOutput =
      typeof raw.tool_response === "string" ? raw.tool_response : JSON.stringify(raw.tool_response);
  }
  normalizeTool(event, tool, input);
  if (kind === "subagent.start" || kind === "subagent.stop") {
    event.spawnSubagentType = string(raw.agent_type);
    event.spawnAgentLabel = string(raw.agent_id);
    // why: the common model describes the caller, not a separately reported child model.
    delete event.model;
  }
  return event;
}

function normalizeTool(
  event: HarnessEvent,
  tool: string | undefined,
  input: Record<string, unknown> | undefined,
): void {
  if (tool === "apply_patch") {
    event.toolName = "Edit";
    const patch = string(input?.command) ?? "";
    // why: move destinations and every file in a batch must pass the same path guards as a single edit.
    event.filePaths = [
      ...new Set(
        [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)]
          .map((match) => (match[1] ?? "").trim())
          .filter(Boolean)
          .map((path) => resolve(event.projectDir, path)),
      ),
    ];
  }
  if (tool === "spawn_agent") {
    event.toolName = "Task";
    event.spawnSubagentType = string(input?.agent_type);
    event.spawnModel = string(input?.model);
  }
}
