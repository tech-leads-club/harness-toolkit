/**
 * The host tool names that write to a file.
 *
 * why here: two rails need the same answer — the policy-surface guard, which refuses an agent write to policy, and
 * the presence claim, which decides whether another session may lose work. A second copy of this list is a second
 * thing to forget when a host adds a tool ([/decisions/ad-010.md](/decisions/ad-010.md)).
 *
 * hazard: the presence claim did not consult any list. It recorded whatever file the event carried, and
 * `read.before` carries one — so reading a file claimed it for ten minutes and blocked every other session from
 * writing it, under a rule called `edit-collision` and a message that said the file had been edited. Measured on a
 * real machine: a review agent that only read poisoned two files, and the operator's own `git status` showed one
 * modification, theirs ([/decisions/ad-099.md](/decisions/ad-099.md)).
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "Delete",
  "MultiEdit",
  "NotebookEdit",
]);

/** invariant: an absent tool name is not a write. A read carries a path too, and only writes may claim one. */
export function isWriteTool(toolName: string | undefined): boolean {
  return toolName !== undefined && WRITE_TOOLS.has(toolName);
}
