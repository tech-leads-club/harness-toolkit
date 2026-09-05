/**
 * Codex emits a payload shaped like Claude Code's — PascalCase `hook_event_name`, `cwd`, `transcript_path` — so
 * there is no single field that says "Codex". What there is instead is a set of things only Codex produces:
 * two events Claude does not have, a tool Claude does not have, and a transcript that lives under `.codex`.
 * Any one of them is enough ([spec.md](../../../.specs/features/add-providers/spec.md), P3 AC1).
 *
 * invariant: this is a fingerprint, not the routing mechanism. Codex wiring launches with `--provider codex`, so
 * the hint channel settles routing before a detector runs. Detection is what claims a payload from a hook someone
 * wired by hand, and what keeps the un-hinted case off Claude's adapter.
 */
const CODEX_ONLY_EVENTS = new Set(["PermissionRequest", "PostCompact"]);

/** why: Codex's own patch tool. Claude spells the same job `Edit` / `Write`, so the name does not collide. */
const CODEX_ONLY_TOOL = "apply_patch";

/** why a path *segment*: `/repo/my.codex-notes/x.jsonl` is not a Codex transcript, and a substring test says it is. */
const CODEX_TRANSCRIPT_DIR = /(^|[/\\])\.codex([/\\]|$)/;

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function isCodexTranscript(value: unknown): boolean {
  return typeof value === "string" && CODEX_TRANSCRIPT_DIR.test(value);
}

export function detectCodex(raw: unknown): boolean {
  const value = asRecord(raw);
  if (value === null) {
    return false;
  }
  const eventName = value.hook_event_name;
  if (typeof eventName === "string" && CODEX_ONLY_EVENTS.has(eventName)) {
    return true;
  }
  if (value.tool_name === CODEX_ONLY_TOOL) {
    return true;
  }
  // why the second field too: a subagent stop carries its child's transcript under `agent_transcript_path` and no
  // `transcript_path` at all, so reading only the first name would leave that payload unfingerprinted.
  return isCodexTranscript(value.transcript_path) || isCodexTranscript(value.agent_transcript_path);
}
