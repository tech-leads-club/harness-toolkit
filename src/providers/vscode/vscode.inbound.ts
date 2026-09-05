import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";
import { VSCODE_PROVIDER } from "./vscode.detect.ts";

/**
 * VS Code's documented event list is `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
 * `PreCompact`, `SubagentStart`, `SubagentStop`, `Stop` ([/decisions/ad-125.md](/decisions/ad-125.md)). There is
 * no session-end event, no tool-failure event, and no message-display event, so this table is shorter than
 * Claude's by exactly those three — a payload shape shared with Claude is not an event list shared with Claude.
 */
const EVENT_KIND_BY_HOOK: Record<string, HarnessEventKind> = {
  SessionStart: "session.start",
  UserPromptSubmit: "prompt.submit",
  SubagentStart: "subagent.start",
  SubagentStop: "subagent.stop",
  Stop: "stop",
  PreCompact: "compact.before",
};

/**
 * hazard: a single underscore, unlike Claude's and Codex's `mcp__`. Neither VS Code source enumerates the MCP
 * tool-name form; this is design §5's value and the fixtures' provenance flags it as the first thing a live
 * capture should confirm.
 */
const MCP_TOOL_NAME = /^mcp_/;

const SHELL_TOOL_NAME = "runTerminalCommand";

/** why two spellings each: the VS Code page names both forms in its own examples (design §5). */
const READ_TOOL_NAMES = new Set(["readFile", "read_file"]);
const EDIT_TOOL_NAMES = new Set(["editFiles", "createFile", "create_file", "replace_string_in_file"]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * why every field is read under two names: GitHub's Copilot hooks reference publishes every VS Code payload in
 * **two formats** — a camelCase one and one it labels VS Code-compatible, "PascalCase with snake_case fields"
 * (`src/providers/vscode/__test__/fixtures/PROVENANCE.md`). Both spellings are documented, so tolerating both is
 * reading the vendor's contract rather than hedging against drift. Agent Hooks being Preview is the second reason,
 * not the first.
 *
 * invariant: the VS Code-compatible spelling is tried first, because that is the format the host's own page
 * describes and every fixture but one is written in.
 */
function field(raw: Record<string, unknown>, snake: string, camel: string): unknown {
  return raw[snake] !== undefined ? raw[snake] : raw[camel];
}

function sessionKeyFor(raw: Record<string, unknown>): string {
  const seed = asString(field(raw, "session_id", "sessionId")) ?? "default";
  return `${VSCODE_PROVIDER}-${sanitizeSegment(seed)}`;
}

/**
 * why not an environment variable: neither source documents an environment given to a hook command, which is what
 * `sessionEnv: false` records. `cwd` is a common field on every documented payload, so it is the only anchor this
 * host offers.
 */
function projectDirFor(raw: Record<string, unknown>): string {
  return asString(raw.cwd) ?? process.cwd();
}

function filePathOf(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput) {
    return undefined;
  }
  return asString(field(toolInput, "filePath", "file_path"));
}

// why one fan-out per direction: VS Code has no dedicated shell, MCP, or read event — `PreToolUse` and
// `PostToolUse` are the only two tool hooks, and the tool name is what separates them (design §5).
function beforeKind(toolName: string | undefined): HarnessEventKind {
  if (toolName === SHELL_TOOL_NAME) {
    return "shell.before";
  }
  if (toolName && MCP_TOOL_NAME.test(toolName)) {
    return "mcp.before";
  }
  if (toolName && READ_TOOL_NAMES.has(toolName)) {
    return "read.before";
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
  if (toolName && EDIT_TOOL_NAMES.has(toolName)) {
    return "edit.after";
  }
  return "tool.after";
}

/** Never throws on a malformed payload — returns null instead. */
export function vscodeToEvent(raw: Record<string, unknown>): HarnessEvent | null {
  const hookEventName = asString(field(raw, "hook_event_name", "hookEventName"));
  if (!hookEventName) {
    return null;
  }

  const toolName = asString(field(raw, "tool_name", "toolName"));
  // why `toolArgs` and not `toolInput` as the camel spelling: `toolArgs` is what the reference's camelCase format
  // actually calls it, and inventing a third name would tolerate a spelling no source publishes.
  const toolInput = asRecord(field(raw, "tool_input", "toolArgs"));

  let eventKind: HarnessEventKind | undefined;
  if (hookEventName === "PreToolUse") {
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
    provider: VSCODE_PROVIDER,
    event: eventKind,
    sessionKey: sessionKeyFor(raw),
    projectDir: projectDirFor(raw),
    raw,
  };

  const cwd = asString(raw.cwd);
  if (cwd) {
    event.cwd = cwd;
  }
  const transcriptPath = asString(field(raw, "transcript_path", "transcriptPath"));
  if (transcriptPath) {
    event.transcriptPath = transcriptPath;
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
    case "read.before": {
      const filePath = filePathOf(toolInput);
      if (filePath !== undefined) {
        event.filePath = filePath;
      }
      break;
    }
    case "edit.after": {
      if (toolName) {
        event.toolName = toolName;
      }
      const filePath = filePathOf(toolInput);
      if (filePath !== undefined) {
        event.filePath = filePath;
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
      /**
       * why the host's names land in the label and never in the type: `agent_name` is what the spawn was called
       * and `agent_type` is the same string echoed back on the stop, so a rule matching either would be matching a
       * string the gated agent chose ([/decisions/ad-104.md](/decisions/ad-104.md)). Neither source publishes a
       * field carrying a *declared* type, so `spawnSubagentType` stays absent on this host.
       */
      const spawnAgentLabel =
        asString(field(raw, "agent_name", "agentName")) ?? asString(field(raw, "agent_type", "agentType"));
      if (spawnAgentLabel) {
        event.spawnAgentLabel = spawnAgentLabel;
      }
      break;
    }
    default:
      break;
  }

  /**
   * why the after-events only, and why `text_result_for_llm` rather than the whole record: `tool_result` is
   * documented on `PostToolUse` and nowhere else, which is what `toolOutputAtAfter: true` records. It arrives as
   * `{ result_type, text_result_for_llm }`, and the second field is the tool output core reads
   * ([/decisions/ad-077.md](/decisions/ad-077.md)); serialising the wrapper would hand every rule a JSON blob
   * whose payload is one key deep.
   */
  if (hookEventName === "PostToolUse") {
    const toolResult = field(raw, "tool_result", "toolResult");
    const text = asString(asRecord(toolResult)?.text_result_for_llm);
    if (text !== undefined) {
      event.toolOutput = text;
    } else if (typeof toolResult === "string") {
      event.toolOutput = toolResult;
    }
  }

  /**
   * invariant: `stop_hook_active` never reaches `loopCount`, and `stop_reason` never reaches `status`. The first
   * is a boolean where `loopCount` is a number the grind cap compares against, so mapping it in would leave the
   * cap unreachable ([/decisions/ad-125.md](/decisions/ad-125.md)). The second carries `"end_turn"`, which is not
   * a member of the `completed | aborted | error` vocabulary — passing it through would put a foreign word in a
   * closed field.
   */

  return event;
}
