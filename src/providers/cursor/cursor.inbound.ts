import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";

export const EVENT_KIND_BY_HOOK: Record<string, HarnessEventKind> = {
  sessionStart: "session.start",
  sessionEnd: "session.end",
  beforeSubmitPrompt: "prompt.submit",
  preToolUse: "tool.before",
  postToolUse: "tool.after",
  postToolUseFailure: "tool.failure",
  beforeShellExecution: "shell.before",
  afterShellExecution: "shell.after",
  beforeMCPExecution: "mcp.before",
  afterMCPExecution: "mcp.after",
  beforeReadFile: "read.before",
  afterFileEdit: "edit.after",
  subagentStart: "subagent.start",
  subagentStop: "subagent.stop",
  stop: "stop",
  preCompact: "compact.before",
  afterAgentResponse: "response.after",
  afterAgentThought: "thought.after",
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * hazard: `beforeMCPExecution`'s own `tool_input` is documented as a JSON *string* ("JSON params string that
 * will be passed to the tool"), not an object like `preToolUse`'s — `asRecord` alone left it `undefined` for
 * every MCP call on this host, silently skipping any rule that reads `toolInput` fields
 * ([/decisions/ad-135.md](/decisions/ad-135.md)).
 */
function mcpToolInput(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) {
    return direct;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asStatus(value: unknown): "completed" | "aborted" | "error" | undefined {
  return value === "completed" || value === "aborted" || value === "error" ? value : undefined;
}

function sessionKeyFor(raw: Record<string, unknown>): string {
  const seed = asString(raw.conversation_id) || asString(raw.session_id) || "default";
  return `cursor-${sanitizeSegment(seed)}`;
}

function projectDirFor(raw: Record<string, unknown>): string {
  const envDir = process.env.CURSOR_PROJECT_DIR;
  if (envDir) {
    return envDir;
  }
  const roots = raw.workspace_roots;
  if (Array.isArray(roots)) {
    const first = asString(roots[0]);
    if (first) {
      return first;
    }
  }
  return process.cwd();
}

/** Never throws on a malformed payload — returns null instead. */
export function cursorToEvent(raw: Record<string, unknown>): HarnessEvent | null {
  const hookEventName = asString(raw.hook_event_name);
  const eventKind = hookEventName ? EVENT_KIND_BY_HOOK[hookEventName] : undefined;
  if (!eventKind) {
    return null;
  }

  const event: HarnessEvent = {
    provider: "cursor",
    event: eventKind,
    sessionKey: sessionKeyFor(raw),
    projectDir: projectDirFor(raw),
    raw,
  };

  const model = asString(raw.model);
  if (model) {
    event.model = model;
  }
  const contextUsagePercent = asNumber(raw.context_usage_percent);
  if (contextUsagePercent !== undefined) {
    event.contextUsagePercent = contextUsagePercent;
  }

  switch (eventKind) {
    case "prompt.submit": {
      const text = asString(raw.prompt);
      if (text !== undefined) {
        event.text = text;
      }
      break;
    }
    case "response.after": {
      const text = asString(raw.text);
      if (text !== undefined) {
        event.text = text;
      }
      break;
    }
    case "thought.after": {
      const text = asString(raw.thought) ?? asString(raw.text);
      if (text !== undefined) {
        event.text = text;
      }
      break;
    }
    case "tool.before":
    case "tool.after":
    case "tool.failure": {
      const toolName = asString(raw.tool_name);
      if (toolName) {
        event.toolName = toolName;
      }
      const toolInput = asRecord(raw.tool_input);
      if (toolInput) {
        event.toolInput = toolInput;
      }
      const subagentType = asString(raw.subagent_type);
      if (subagentType) {
        event.subagentType = subagentType;
      }
      const toolSpawnModel = toolInput ? asString(toolInput.model) : undefined;
      if (toolSpawnModel) {
        event.spawnModel = toolSpawnModel;
      }
      const toolSpawnType = toolInput ? asString(toolInput.subagent_type) : undefined;
      if (toolSpawnType) {
        event.spawnSubagentType = toolSpawnType;
      }
      break;
    }
    case "shell.before":
    case "shell.after": {
      const command = asString(raw.command);
      if (command !== undefined) {
        event.command = command;
      }
      const output = asString(raw.output);
      if (output !== undefined) {
        event.toolOutput = output;
      }
      // why: confirmed against cursor.com/docs/hooks — `cwd` exists only on `beforeShellExecution`
      // (this event's `shell.before` half), not on `afterShellExecution` or any other event this
      // adapter maps. Never guessed onto an event kind the host does not report it for
      // ([/decisions/ad-114.md](/decisions/ad-114.md)).

      // hazard: found live — Cursor sends `cwd: ""` on a command that never entered a worktree, not an
      // absent field. `shaScopeRoot` treats any non-nullish `event.cwd` as an override, so `""` beat the
      // real `projectDir` and resolved a rule proof's sha against the wrong directory entirely
      // ([/decisions/ad-141.md](/decisions/ad-141.md)) — a truthy check, like `claude.inbound.ts` already uses.
      if (eventKind === "shell.before") {
        const cwd = asString(raw.cwd);
        if (cwd) {
          event.cwd = cwd;
        }
      }
      break;
    }
    case "mcp.before":
    case "mcp.after": {
      const resultJson = asString(raw.result_json);
      if (resultJson !== undefined) {
        event.toolOutput = resultJson;
      }
      const toolName = asString(raw.tool_name);
      if (toolName) {
        event.toolName = toolName;
      }
      const toolInput = mcpToolInput(raw.tool_input);
      if (toolInput) {
        event.toolInput = toolInput;
      }
      const command = asString(raw.command);
      if (command !== undefined) {
        event.command = command;
      }
      break;
    }
    case "read.before":
    case "edit.after": {
      const filePath = asString(raw.file_path);
      if (filePath !== undefined) {
        event.filePath = filePath;
      }
      break;
    }
    case "subagent.start":
    case "subagent.stop": {
      const spawnSubagentType = asString(raw.subagent_type);
      if (spawnSubagentType) {
        event.spawnSubagentType = spawnSubagentType;
      }
      const spawnModel = asString(raw.subagent_model);
      if (spawnModel) {
        event.spawnModel = spawnModel;
      }
      break;
    }
    case "stop": {
      const status = asStatus(raw.status);
      if (status) {
        event.status = status;
      }
      const loopCount = asNumber(raw.loop_count);
      if (loopCount !== undefined) {
        event.loopCount = loopCount;
      }
      break;
    }
    default:
      break;
  }

  return event;
}
