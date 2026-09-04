import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";

/**
 * why one parser for both generations: the two plugin APIs differ in what the harness can *do* — which is what
 * the capability descriptors carry — not in the shape the bridge puts on stdin. The envelope is harness-defined
 * and identical across them ([/decisions/ad-124.md](/decisions/ad-124.md)), so a second parser would be two
 * copies of one fan-out drifting apart.
 */
export const OPENCODE_PROVIDER_BY_API: Record<string, string> = {
  legacy: "opencode-legacy",
  namespaced: "opencode-namespaced",
};

/**
 * opencode's own tool spellings, all lower case.
 *
 * why `patch` and `apply_patch` both: the tools reference names `apply_patch`, while the transcription's fan-out
 * and T1's fixtures say `patch`. Neither is a guess and the cost of accepting both is nothing, where accepting
 * one would send half the edits to the generic kind.
 */
const SHELL_TOOLS = new Set(["bash", "shell"]);
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch"]);
const READ_TOOLS = new Set(["read"]);
const MCP_PREFIX = "mcp_";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** invariant: `error` is opencode's own `status` value on `execute.after`; the host has no `aborted`. */
function asStatus(value: unknown): "completed" | "error" | undefined {
  return value === "completed" || value === "error" ? value : undefined;
}

function toolKind(tool: string | undefined, phase: "before" | "after"): HarnessEventKind {
  if (tool === undefined) {
    return phase === "before" ? "tool.before" : "tool.after";
  }
  if (SHELL_TOOLS.has(tool)) {
    return phase === "before" ? "shell.before" : "shell.after";
  }
  if (tool.startsWith(MCP_PREFIX)) {
    return phase === "before" ? "mcp.before" : "mcp.after";
  }
  // why: an edit is only observable after it happened, and a read is only worth gating before it does. The other
  // half of each pair falls to the generic kind rather than being invented.
  if (phase === "after" && EDIT_TOOLS.has(tool)) {
    return "edit.after";
  }
  if (phase === "before" && READ_TOOLS.has(tool)) {
    return "read.before";
  }
  return phase === "before" ? "tool.before" : "tool.after";
}

function sessionKeyFor(raw: Record<string, unknown>): string {
  // why: the host session is one session whichever plugin API observed it, so the key is keyed to opencode and
  // not to the adapter name. Switching generation mid-session must not orphan the handoff.
  const seed = asString(raw.sessionID) || "default";
  return `opencode-${sanitizeSegment(seed)}`;
}

function projectDirFor(raw: Record<string, unknown>): string {
  // why `TLC_PROJECT_DIR` and no vendor variable: opencode documents no environment given to a plugin, so the
  // only variable in play is the one this harness's own launcher sets ([/decisions/ad-124.md](/decisions/ad-124.md)).
  const envDir = process.env.TLC_PROJECT_DIR;
  if (envDir) {
    return envDir;
  }
  return asString(raw.cwd) ?? process.cwd();
}

/** Never throws on a malformed payload — returns null instead. */
export function opencodeToEvent(raw: Record<string, unknown>): HarnessEvent | null {
  const provider = OPENCODE_PROVIDER_BY_API[asString(raw.pluginApi) ?? ""];
  if (raw.provider !== "opencode" || provider === undefined) {
    return null;
  }
  const hook = asString(raw.hook);
  if (hook === undefined) {
    return null;
  }

  const tool = asString(raw.tool);
  const args = asRecord(raw.args);

  const eventKind = kindFor(hook, tool);
  if (eventKind === null) {
    return null;
  }

  const event: HarnessEvent = {
    provider,
    event: eventKind,
    sessionKey: sessionKeyFor(raw),
    projectDir: projectDirFor(raw),
    raw,
  };

  if (tool !== undefined) {
    event.toolName = tool;
  }
  if (args !== undefined) {
    event.toolInput = args;
  }

  // why: the shell hook carries the command at the top level, the tool hooks carry it inside `args`. Both are
  // documented spellings, and a rail matching on `command` should not have to know which hook it came from.
  const command = asString(raw.command) ?? (args ? asString(args.command) : undefined);
  if (command !== undefined) {
    event.command = command;
  }
  const filePath = args ? asString(args.filePath) : undefined;
  if (filePath !== undefined) {
    event.filePath = filePath;
  }
  const cwd = asString(raw.cwd);
  if (cwd !== undefined) {
    event.cwd = cwd;
  }
  const status = asStatus(raw.status);
  if (status !== undefined) {
    event.status = status;
  }

  return event;
}

function kindFor(hook: string, tool: string | undefined): HarnessEventKind | null {
  switch (hook) {
    case "tool.execute.before":
      return toolKind(tool, "before");
    case "tool.execute.after":
      return toolKind(tool, "after");
    // why: the namespaced shell hook intercepts execution on its own, so it maps straight to `shell.before`
    // without passing through the tool fan-out — there is no `tool` field on it to fan out on.
    case "shell.create.before":
      return "shell.before";
    /**
     * hazard: `permission.evaluate` is the ask channel, and a rule can only answer it if it knows what is being
     * asked about. The documented payload carries `effect` and `message` and no tool, so a bridge that does not
     * stamp `tool` leaves this unmapped rather than raising a `tool.before` no rule can match on
     * ([/decisions/ad-124.md](/decisions/ad-124.md)). T8's namespaced bridge stamps it.
     */
    case "permission.evaluate":
      return tool === undefined ? null : toolKind(tool, "before");
    default:
      return null;
  }
}
