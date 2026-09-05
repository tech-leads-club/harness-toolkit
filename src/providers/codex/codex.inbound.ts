import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";

/**
 * The events that map straight through. `PostCompact` and `Interrupt` are documented and deliberately absent:
 * `HarnessEventKind` has no compact-after and no interrupt member, and inventing a near-enough kind for either
 * would deliver them to rules written for a different moment in the turn. They stay unmapped until the union has
 * somewhere honest to put them — the detector still fingerprints `PostCompact`, because claiming the payload and
 * parsing it are different questions.
 */
const EVENT_KIND_BY_HOOK: Record<string, HarnessEventKind> = {
  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "prompt.submit",
  SubagentStart: "subagent.start",
  SubagentStop: "subagent.stop",
  Stop: "stop",
  PreCompact: "compact.before",
};

const MCP_TOOL_NAME = /^mcp__/;

const SHELL_TOOL_NAME = "Bash";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sessionKeyFor(raw: Record<string, unknown>): string {
  const seed = asString(raw.session_id) ?? "default";
  return `codex-${sanitizeSegment(seed)}`;
}

/**
 * why not an environment variable: Codex documents `PLUGIN_ROOT` and `PLUGIN_DATA` for plugin-bundled hooks only
 * and nothing for a `hooks.json` command, which is what `sessionEnv: false` records. `cwd` is on every documented
 * payload, so it is the only anchor this host actually offers.
 */
function projectDirFor(raw: Record<string, unknown>): string {
  return asString(raw.cwd) ?? process.cwd();
}

/**
 * why one function for both before-events: `PermissionRequest` is the same moment as `PreToolUse` — a tool about
 * to run — and differs only in the response vocabulary, which is the renderer's problem, not the parser's.
 *
 * hazard: the single highest-risk mapping in this adapter is the one written here as an absence. `apply_patch`
 * has no branch, so it falls through to the generic kind — which is the point. Its `tool_input.command` holds
 * patch text, not a shell command, and a branch sending it to `shell.*` would feed a patch body to every
 * shell-command rule an operator wrote (design §5, spec P3 AC3).
 */
function beforeKind(toolName: string | undefined): HarnessEventKind {
  if (toolName === SHELL_TOOL_NAME) {
    return "shell.before";
  }
  if (toolName && MCP_TOOL_NAME.test(toolName)) {
    return "mcp.before";
  }
  return "tool.before";
}

function afterKind(toolName: string | undefined): HarnessEventKind {
  if (toolName === SHELL_TOOL_NAME) {
    return "shell.after";
  }
  if (toolName && MCP_TOOL_NAME.test(toolName)) {
    return "mcp.after";
  }
  return "tool.after";
}

/** Never throws on a malformed payload — returns null instead. */
export function codexToEvent(raw: Record<string, unknown>): HarnessEvent | null {
  const hookEventName = asString(raw.hook_event_name);
  if (!hookEventName) {
    return null;
  }

  const toolName = asString(raw.tool_name);
  const toolInput = asRecord(raw.tool_input);

  let eventKind: HarnessEventKind | undefined;
  if (hookEventName === "PreToolUse" || hookEventName === "PermissionRequest") {
    eventKind = beforeKind(toolName);
  } else if (hookEventName === "PostToolUse") {
    eventKind = afterKind(toolName);
  } else {
    eventKind = EVENT_KIND_BY_HOOK[hookEventName];
  }
  if (!eventKind) {
    return null;
  }

  const event: HarnessEvent = {
    provider: "codex",
    event: eventKind,
    sessionKey: sessionKeyFor(raw),
    projectDir: projectDirFor(raw),
    raw,
  };

  const permissionMode = asString(raw.permission_mode);
  if (permissionMode) {
    event.permissionMode = permissionMode;
  }
  const cwd = asString(raw.cwd);
  if (cwd) {
    event.cwd = cwd;
  }
  const transcriptPath = asString(raw.transcript_path);
  if (transcriptPath) {
    event.transcriptPath = transcriptPath;
  }

  const isSpawnEvent = eventKind === "subagent.start" || eventKind === "subagent.stop";
  const model = isSpawnEvent ? undefined : asString(raw.model);
  if (model) {
    event.model = model;
  }

  switch (eventKind) {
    case "prompt.submit": {
      const text = asString(raw.prompt);
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
    case "mcp.after":
    case "tool.before":
    case "tool.after": {
      if (toolName) {
        event.toolName = toolName;
      }
      if (toolInput) {
        event.toolInput = toolInput;
      }
      break;
    }
    case "subagent.start":
    case "subagent.stop": {
      // why `agent_type` lands in the label and not in the type: it is what the spawn was called, and a rule that
      // matched on it would be matching a string the gated agent chose ([/decisions/ad-104.md](/decisions/ad-104.md)).
      const spawnAgentLabel = asString(raw.agent_type);
      if (spawnAgentLabel) {
        event.spawnAgentLabel = spawnAgentLabel;
      }
      break;
    }
    default:
      break;
  }

  /**
   * why the after-events only: `tool_response` is documented on `PostToolUse` and nowhere else, which is what
   * `toolOutputAtAfter: true` records. It is an object here, unlike the string one host uses, and serialising it
   * is the translation this layer exists to do ([/decisions/ad-004.md](/decisions/ad-004.md)).
   */
  if (hookEventName === "PostToolUse") {
    const toolOutput = raw.tool_response;
    if (toolOutput !== undefined && toolOutput !== null) {
      event.toolOutput = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);
    }
  }

  /**
   * invariant: `stop_hook_active` never reaches `loopCount`. It is a boolean saying a hook already forced this
   * turn to continue; `loopCount` is a number the grind cap compares against, so a boolean mapped in would yield
   * at most 1 and the cap would never be reached ([/decisions/ad-123.md](/decisions/ad-123.md)).
   */

  return event;
}
