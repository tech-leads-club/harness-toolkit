// why: Claude payloads use PascalCase hook_event_name + cwd/transcript_path; Cursor payloads don't.
const PASCAL_CASE_EVENT_NAME = /^[A-Z][a-zA-Z0-9]*$/;

export function detectClaude(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const value = raw as Record<string, unknown>;
  if (value._tlc_provider === "codex") return false;
  const eventName = value.hook_event_name;
  if (typeof eventName !== "string" || !PASCAL_CASE_EVENT_NAME.test(eventName)) {
    return false;
  }
  return typeof value.cwd === "string" || typeof value.transcript_path === "string";
}
