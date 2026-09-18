import type { Decision, HarnessEvent, Rendered } from "../../contracts/index.ts";

// why: key order (permission, user_message, agent_message) matches the captured golden byte-for-byte.
function renderDenyOrAsk(
  permission: "deny" | "ask",
  decision: { reason: string; userNote?: string },
): string {
  const body: Record<string, unknown> = { permission };
  if (decision.userNote !== undefined) {
    body.user_message = decision.userNote;
  }
  body.agent_message = decision.reason;
  return JSON.stringify(body);
}

export function cursorRender(decision: Decision, _event: HarnessEvent): Rendered {
  switch (decision.kind) {
    case "abstain":
      return { stdout: "{}", exitCode: 0 };
    case "allow":
      return { stdout: JSON.stringify({ permission: "allow" }), exitCode: 0 };
    case "deny":
      return { stdout: renderDenyOrAsk("deny", decision), exitCode: 0 };
    case "ask":
      return { stdout: renderDenyOrAsk("ask", decision), exitCode: 0 };
    case "context": {
      const body: Record<string, unknown> = {};
      if (decision.env !== undefined) {
        body.env = decision.env;
      }
      body.additional_context = decision.text;
      return { stdout: JSON.stringify(body), exitCode: 0 };
    }
    case "continue":
      return { stdout: JSON.stringify({ followup_message: decision.text }), exitCode: 0 };
    case "rewriteInput":
      return { stdout: JSON.stringify({ updated_input: decision.input }), exitCode: 0 };
    // hazard: Cursor's docs declare `updated_mcp_tool_output` as an object with no documented inner keys —
    // `result_json` mirrors the field this same event reads the original output from (`cursor.inbound.ts`).
    // `provider.degrade.ts` only lets `rewriteOutput` reach here for `mcp.after`; every other event is already
    // `context` by the time render runs.
    case "rewriteOutput":
      return {
        stdout: JSON.stringify({ updated_mcp_tool_output: { result_json: decision.output } }),
        exitCode: 0,
      };
    default: {
      const exhaustive: never = decision;
      throw new Error(`unreachable decision kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
