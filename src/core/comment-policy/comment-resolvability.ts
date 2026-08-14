/**
 * A comment is resolvable when a reader at HEAD — with no transcript of the session that wrote it, no pull
 * request thread and no draft — can resolve every reference in it and check every claim.
 *
 * why: the existing modes ask whether a comment *declares* a reason. They cannot ask whether the reason means
 * anything to somebody who was not there, and that is the comment a model actually writes: it narrates the
 * change it just made, cites a numbered item only the session could see, or argues with a reviewer who has since
 * left. Each one reads as a reason and resolves to nothing
 * ([/decisions/ad-070.md](/decisions/ad-070.md)).
 *
 * invariant: prose, never syntax. Nothing here parses a language, so a new language costs nothing and the rule
 * behaves identically in Go, Python and TypeScript — the constraint that produced the syntax catalog
 * ([/decisions/ad-058.md](/decisions/ad-058.md)).
 */
export type LeakKind =
  | "change-narration"
  | "dead-citation"
  | "review-vantage"
  | "reviewer-addressed"
  | "flow-narration";

export type LeakRule = {
  kind: LeakKind;
  pattern: RegExp;
  /** What the reader at HEAD cannot do, phrased so the fix is obvious from the message. */
  says: string;
};

/**
 * hazard: precision over recall, deliberately. A rail that flags a good comment teaches the operator to switch it
 * off, and the next real finding goes with it ([/decisions/ad-034.md](/decisions/ad-034.md)). Every pattern here
 * is one that cannot be true of a comment describing present behaviour: a past-tense claim about the code is
 * never a statement about what it does now, and a parenthesised decision number never resolves from the
 * repository.
 */
export const LEAK_RULES: readonly LeakRule[] = [
  /**
   * hazard: `no longer` was here and was dropped on the evidence. Every occurrence in this repository described
   * *runtime* state — a lock owner that no longer exists, a lesson ref that no longer resolves, a path a future
   * refactor would leave behind — and not one described the repository's own history. A phrase that is four
   * times wrong and zero times right is a phrase that trains the operator to switch the rail off.
   */
  {
    kind: "change-narration",
    pattern: /\b(?:used to|previously)\b/i,
    says: "narrates the change instead of the state",
  },
  {
    kind: "change-narration",
    pattern: /\bthis (?:was|used to)\b/i,
    says: "narrates the change instead of the state",
  },
  {
    kind: "change-narration",
    pattern: /\bthe old (?:code|version|implementation|approach|way|behaviou?r)\b/i,
    says: "refers to code that is no longer here",
  },
  {
    kind: "change-narration",
    pattern: /\bbefore (?:this|the) (?:change|commit|fix|patch|refactor)\b/i,
    says: "refers to a state the repository no longer holds",
  },
  {
    kind: "dead-citation",
    pattern: /\((?:decision|item|step|phase|task|audit|option)\s*#?\d+\)/i,
    says: "cites something only the authoring session could see",
  },
  {
    kind: "dead-citation",
    pattern: /§\s*\d/,
    says: "cites a section of a document that is not in the repository",
  },
  {
    kind: "dead-citation",
    pattern: /\bas (?:decided|agreed|discussed|mentioned|described) (?:above|earlier|previously|before)\b/i,
    says: "points at a conversation the reader cannot see",
  },
  {
    kind: "dead-citation",
    pattern: /\b(?:per|from|in) the plan\b|\bthe plan above\b/i,
    says: "points at a plan that is not in the repository",
  },
  {
    kind: "review-vantage",
    pattern: /\bthis (?:PR|MR|commit|patch|diff|changeset)\b/i,
    says: "speaks from the change rather than from the repository",
  },
  {
    kind: "review-vantage",
    pattern: /\ba (?:later|follow-?up|subsequent) (?:PR|MR|commit)\b/i,
    says: "speaks from the change rather than from the repository",
  },
  {
    kind: "reviewer-addressed",
    pattern: /\bthis is (?:safe|correct|fine|ok|okay)\b/i,
    says: "argues its own correctness to a reviewer instead of stating the invariant",
  },
  {
    kind: "reviewer-addressed",
    pattern: /\brejected in review\b|\bthe reviewer\b/i,
    says: "records who said what, which the repository cannot confirm",
  },
  {
    kind: "flow-narration",
    pattern: /\bfirst (?:we|it|this)\b[\s\S]{0,80}\bthen (?:we|it|this)\b/i,
    says: "restates the control flow the code already shows",
  },
];

export type Leak = { kind: LeakKind; says: string; match: string };

/**
 * why: the whole block is judged as one string. A sentence split across two comment lines is still one sentence,
 * and a pattern spanning a clause only matches once the lines are joined.
 */
export function findLeaks(blockText: string): Leak[] {
  const leaks: Leak[] = [];
  for (const rule of LEAK_RULES) {
    const found = rule.pattern.exec(blockText);
    if (found !== null) {
      leaks.push({ kind: rule.kind, says: rule.says, match: found[0] });
    }
  }
  return leaks;
}

/** why: one comment yields one finding, so a block matching three rules does not read as three problems. */
export function firstLeak(blockText: string): Leak | null {
  return findLeaks(blockText)[0] ?? null;
}

export function leakReason(leak: Leak): string {
  return `unresolvable comment — ${leak.says} (\`${leak.match}\`)`;
}
