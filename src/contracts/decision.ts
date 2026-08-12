/**
 * why: `rule` is the machine-readable form of a thing the codebase already wanted — the floor hand-writes
 * `rule=policy-surface-write` into its reason prose, and anything wanting to attribute a decision had to parse
 * English. Optional, because a decision is valid without one; a consumer that wants attribution and finds none
 * reports it as unattributed rather than guessing.
 */
export type Decision =
  | { kind: "abstain" }
  | { kind: "allow" }
  | { kind: "deny"; reason: string; userNote?: string; rule: string }
  | { kind: "ask"; reason: string; userNote?: string; rule: string }
  | { kind: "context"; text: string; env?: Record<string, string> }
  | { kind: "continue"; text: string }
  | { kind: "rewriteInput"; input: Record<string, unknown>; reason: string };

export type Rendered = {
  // invariant: null means write nothing; a provider whose abstain is a literal "{}" sets it explicitly.
  stdout: string | null;
  // invariant: always 0 — exit code is never used as a policy channel.
  exitCode: number;
};
