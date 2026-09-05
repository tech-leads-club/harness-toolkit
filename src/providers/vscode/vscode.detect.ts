/**
 * VS Code Agent Hooks emit Claude Code's payload byte for byte — same PascalCase `hook_event_name`, same
 * `session_id`, same `cwd`, same `tool_name` / `tool_input` pair
 * (`src/providers/vscode/__test__/fixtures/PROVENANCE.md`). There is no field that says "VS Code", so detection by
 * content is impossible here rather than merely hard, and no registry ordering fixes it
 * ([spec.md](../../../.specs/features/add-providers/spec.md), P4 AC1).
 *
 * invariant: this detector reads the hint and nothing else. A content clause added later would claim Claude's
 * payloads too, and `resolveFromRegistry` would report `ambiguous` on every Claude hook.
 */
export const VSCODE_PROVIDER = "vscode";

export function detectVSCode(raw: unknown): boolean {
  const hint = process.env.TLC_PROVIDER_HINT?.trim();
  if (hint !== VSCODE_PROVIDER) {
    return false;
  }
  // why an object check even behind the hint: `toEvent` is typed for a record, and a hint is a wiring fact rather
  // than a promise about what arrived on stdin. Claiming a non-object would hand the parser something it cannot read.
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}
