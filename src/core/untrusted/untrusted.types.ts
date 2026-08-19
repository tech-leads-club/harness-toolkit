export type UntrustedSource = "web" | "mcp" | "shell";

export type UntrustedHit = {
  source: UntrustedSource;
  detail: string;
};

export type UntrustedDetectInput = {
  event: string;
  toolName?: string;
  command?: string;
  tools: readonly string[];
  commandPatterns: readonly string[];
};

/**
 * `frame` states once per turn that outside content is data. `enforce` adds the question framing cannot ask —
 * did this command come from that content — and answers it verbatim
 * ([/decisions/ad-077.md](/decisions/ad-077.md)).
 */
export type UntrustedMode = "frame" | "enforce";

export type UntrustedPolicyConfig = {
  enabled: boolean;
  mode: UntrustedMode;
  extraTools: string[];
  extraCommandPatterns: string[];
};

// why: a declared list, never an inference over output. Guessing whether text came from outside the repo
// would make the rail fire on ordinary work and teach the operator to ignore it. Each entry is matched at
// the start of a command segment, so naming one inside a string or a heredoc is not a read.
export const DEFAULT_UNTRUSTED_COMMAND_PATTERNS = [
  "gh pr view",
  "gh pr diff",
  "gh pr list",
  "gh issue view",
  "gh issue list",
  "gh api",
  "curl",
  "wget",
] as const;
