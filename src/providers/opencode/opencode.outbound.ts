import type { Decision, Rendered } from "../../contracts/index.ts";

/**
 * why this adapter renders the decision itself rather than a host wire format: opencode has no stdout contract.
 * The bridge plugin this harness emits is the thing that acts — it throws to block, mutates the tool arguments to
 * rewrite, appends to carry context — so what crosses the pipe is the core decision and the *plugin* is the
 * renderer (design §6).
 *
 * invariant: the decision reaching here has already been through `degrade()`, so an `ask` on the legacy
 * generation is already a `deny` and this function never has to know which generation it is serving.
 */
export function opencodeRender(decision: Decision, _event: unknown): Rendered {
  switch (decision.kind) {
    /**
     * why nothing on the wire: the bridge treats empty stdout as "carry on", which is what all three of these
     * mean. `continue` joins them because opencode wires no stop hook — there is no turn for it to extend.
     */
    case "abstain":
    case "allow":
    case "continue":
      return { stdout: null, exitCode: 0 };
    default:
      // invariant: exit code is never a policy channel. The plugin reads stdout or it does nothing.
      return { stdout: JSON.stringify(decision), exitCode: 0 };
  }
}
