import type { Decision } from "../../contracts/decision.ts";
import { isPolicySurface } from "../floor/floor.paths.ts";

export { isPolicySurface };

const WRITE_TOOLS = new Set(["Edit", "Write", "Delete", "MultiEdit", "NotebookEdit"]);

export function guardPolicySurface(args: {
  projectDir: string;
  toolName: string | undefined;
  filePath: string | undefined;
}): Decision {
  if (!args.toolName || !WRITE_TOOLS.has(args.toolName) || !args.filePath) {
    return { kind: "allow" };
  }
  if (!isPolicySurface(args.projectDir, args.filePath)) {
    return { kind: "allow" };
  }
  // hazard: this used to answer "change policy through the CLI instead", naming the very subcommands the floor
  // refuses from inside a session. Measured: the agent read it as a route, ran `tlc harness mode`, and was denied
  // again — a suggestion that costs a turn and teaches nothing. The CLI is the operator's route, not the reader's.
  return {
    kind: "deny",
    reason: [
      "Harness policy and state are not agent-writable — a gate an agent can switch off is not a gate.",
      "The harness CLI does not help you here either: the same floor rule refuses the mutating subcommands from inside a session.",
      "Tell the operator which value you would change and why, and let them run it from their own terminal.",
    ].join(" "),
    userNote: `Blocked an agent write to ${args.filePath}.`,
    // why: the shell route to the same paths denies with `rule=policy-surface-write` and this one carried no rule
    // at all, so the tool half of one guard was unattributable in the report that counts refusals by rule.
    rule: "policy-surface-write",
  };
}
