import { isEffortLevel } from "../../contracts/effort.ts";
import type { EffortLevel, HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";

const EVENT_KIND_BY_HOOK: Record<string, HarnessEventKind> = {
  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "prompt.submit",
  PostToolUseFailure: "tool.failure",
  SubagentStart: "subagent.start",
  SubagentStop: "subagent.stop",
  Stop: "stop",
  PreCompact: "compact.before",
  MessageDisplay: "response.after",
};

const MCP_TOOL_NAME = /^mcp__/;

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

function asStatus(value: unknown): "completed" | "aborted" | "error" | undefined {
  return value === "completed" || value === "aborted" || value === "error" ? value : undefined;
}

function sessionKeyFor(raw: Record<string, unknown>): string {
  const seed = asString(raw.session_id) ?? "default";
  return `claude-${sanitizeSegment(seed)}`;
}

function projectDirFor(raw: Record<string, unknown>): string {
  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (envDir) {
    return envDir;
  }
  const cwd = asString(raw.cwd);
  if (cwd) {
    return cwd;
  }
  return process.cwd();
}

function effortFor(raw: Record<string, unknown>): EffortLevel | undefined {
  const effort = asRecord(raw.effort);
  const level = effort?.level;
  return isEffortLevel(level) ? level : undefined;
}

// why: PreToolUse fans out by tool_name — Claude has no dedicated shell/MCP/read event.
function preToolUseKind(toolName: string | undefined): HarnessEventKind {
  if (toolName === "Bash") {
    return "shell.before";
  }
  if (toolName && MCP_TOOL_NAME.test(toolName)) {
    return "mcp.before";
  }
  if (toolName === "Read") {
    return "read.before";
  }
  return "tool.before";
}

function postToolUseKind(toolName: string | undefined): HarnessEventKind {
  if (toolName === "Bash") {
    return "shell.after";
  }
  if (toolName && MCP_TOOL_NAME.test(toolName)) {
    return "mcp.after";
  }
  if (toolName === "Edit" || toolName === "Write") {
    return "edit.after";
  }
  return "tool.after";
}

/** Never throws on a malformed payload — returns null instead. */
export function claudeToEvent(raw: Record<string, unknown>): HarnessEvent | null {
  const hookEventName = asString(raw.hook_event_name);
  if (!hookEventName) {
    return null;
  }

  const toolName = asString(raw.tool_name);
  const toolInput = asRecord(raw.tool_input);

  let eventKind: HarnessEventKind | undefined;
  if (hookEventName === "PreToolUse") {
    eventKind = preToolUseKind(toolName);
  } else if (hookEventName === "PostToolUse") {
    eventKind = postToolUseKind(toolName);
  } else {
    eventKind = EVENT_KIND_BY_HOOK[hookEventName];
  }
  if (!eventKind) {
    return null;
  }

  const event: HarnessEvent = {
    provider: "claude",
    event: eventKind,
    sessionKey: sessionKeyFor(raw),
    projectDir: projectDirFor(raw),
    raw,
  };

  const permissionMode = asString(raw.permission_mode);
  if (permissionMode) {
    event.permissionMode = permissionMode;
  }

  const isSpawnEvent = eventKind === "subagent.start" || eventKind === "subagent.stop";
  const model = isSpawnEvent ? undefined : asString(raw.model);
  if (model) {
    event.model = model;
  }
  const effort = effortFor(raw);
  if (effort) {
    event.effort = effort;
  }
  const contextUsagePercent = asNumber(raw.context_usage_percent);
  if (contextUsagePercent !== undefined) {
    event.contextUsagePercent = contextUsagePercent;
  }
  const transcriptPath = asString(raw.transcript_path);
  if (transcriptPath) {
    event.transcriptPath = transcriptPath;
  }
  if (!isSpawnEvent) {
    const callerAgentType = asString(raw.agent_type);
    if (callerAgentType) {
      event.subagentType = callerAgentType;
    }
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
    case "shell.before":
    case "shell.after": {
      const command = toolInput ? asString(toolInput.command) : undefined;
      if (command !== undefined) {
        event.command = command;
      }
      break;
    }
    case "mcp.before":
    case "mcp.after": {
      if (toolName) {
        event.toolName = toolName;
      }
      if (toolInput) {
        event.toolInput = toolInput;
      }
      break;
    }
    case "read.before": {
      const filePath = toolInput ? asString(toolInput.file_path) : undefined;
      if (filePath !== undefined) {
        event.filePath = filePath;
      }
      break;
    }
    case "edit.after": {
      if (toolName) {
        event.toolName = toolName;
      }
      const filePath = toolInput ? asString(toolInput.file_path) : undefined;
      if (filePath !== undefined) {
        event.filePath = filePath;
      }
      break;
    }
    case "tool.before":
    case "tool.after":
    case "tool.failure": {
      if (toolName) {
        event.toolName = toolName;
      }
      // why: an object here, unlike the two string fields Cursor uses. Serialising is the translation this layer
      // exists to do, and core reads one shape ([/decisions/ad-004.md](/decisions/ad-004.md)).
      const toolOutput = raw.tool_response;
      if (toolOutput !== undefined && toolOutput !== null) {
        event.toolOutput = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);
      }
      if (toolInput) {
        event.toolInput = toolInput;
      }
      const filePath = toolInput ? asString(toolInput.file_path) : undefined;
      if (filePath !== undefined) {
        event.filePath = filePath;
      }
      const spawnSubagentType = toolInput ? asString(toolInput.subagent_type) : undefined;
      if (spawnSubagentType) {
        event.spawnSubagentType = spawnSubagentType;
      }
      // why the name too: an addressable spawn carries one, and it is the value the host echoes back as
      // `agent_type` at the stop. Without it here, the stop cannot be resolved to the type the spawn declared
      // ([/decisions/ad-104.md](/decisions/ad-104.md)).
      const spawnAgentLabel = toolInput ? asString(toolInput.name) : undefined;
      if (spawnAgentLabel) {
        event.spawnAgentLabel = spawnAgentLabel;
      }
      const spawnModel = toolInput ? asString(toolInput.model) : undefined;
      if (spawnModel) {
        event.spawnModel = spawnModel;
      }
      break;
    }
    case "subagent.start":
    case "subagent.stop": {
      /**
       * hazard: `agent_type` was read here as the type. The hooks reference describes it as the agent's *name*,
       * and when a spawn is given a `name` the host puts that name in it — measured on a real payload:
       * `subagent_type: "the-judge"` at the spawn, `agent_type: "judge-harness-rule"` inside the child. So the
       * value a rule had to match was the one the gated agent chose, which broke a legitimate review and made the
       * proof forgeable ([/decisions/ad-104.md](/decisions/ad-104.md)).
       *
       * invariant: only a field that means the declared type lands in `spawnSubagentType`. The host's label goes
       * to `spawnAgentLabel`, and the correlation with the spawn resolves it.
       */
      const spawnSubagentType =
        asString(raw.subagent_type) ?? (toolInput ? asString(toolInput.subagent_type) : undefined);
      if (spawnSubagentType) {
        event.spawnSubagentType = spawnSubagentType;
      }
      const spawnAgentLabel = asString(raw.agent_type) ?? (toolInput ? asString(toolInput.name) : undefined);
      if (spawnAgentLabel) {
        event.spawnAgentLabel = spawnAgentLabel;
      }
      const spawnModel = (toolInput ? asString(toolInput.model) : undefined) ?? asString(raw.model);
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
      break;
    }
    default:
      break;
  }

  return event;
}
