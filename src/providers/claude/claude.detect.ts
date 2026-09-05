import { detectCodex } from "../codex/codex.detect.ts";

// why: Claude payloads use PascalCase hook_event_name + cwd/transcript_path; Cursor payloads don't.
const PASCAL_CASE_EVENT_NAME = /^[A-Z][a-zA-Z0-9]*$/;

const CLAUDE_PROVIDER = "claude";

export function detectClaude(raw: unknown): boolean {
  /**
   * why a detector reads the hint at all, when a hint already short-circuits detection in `run.ts`: this shape is
   * the widest of the PascalCase hosts, so it is the one that claims a payload meant for another. A caller that
   * resolves by content while a hint names a different host — a test, a future content-based VS Code detector, or
   * any second call site — would hand that host's payload to this parser, which reads it into an event with fields
   * quietly absent. Answering `false` costs nothing when the hint says `claude`, because the hint path never
   * reaches here.
   */
  const hint = process.env.TLC_PROVIDER_HINT?.trim();
  if (hint !== undefined && hint !== "" && hint !== CLAUDE_PROVIDER) {
    return false;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  /**
   * why Claude declines a Codex payload rather than letting registry order settle it: order does pick Codex, but
   * `resolveFromRegistry` also reports `ambiguous` whenever two detectors match, and `run.ts` records that as
   * `adapter.ambiguous`. Left alone, every fingerprinted Codex hook would write one — turning a record that exists
   * to flag a real collision into a line the operator learns to ignore.
   */
  if (detectCodex(raw)) {
    return false;
  }
  const value = raw as Record<string, unknown>;
  const eventName = value.hook_event_name;
  if (typeof eventName !== "string" || !PASCAL_CASE_EVENT_NAME.test(eventName)) {
    return false;
  }
  return typeof value.cwd === "string" || typeof value.transcript_path === "string";
}
