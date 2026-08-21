/**
 * Reading an operator rule, and merging the two tiers.
 *
 * invariant: pure. The caller reads the directories and hands over `{ name, tier, text }`; this decides what they
 * mean. That is what makes the whole vocabulary testable without a filesystem
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
import { asList, parseFrontmatterDoc } from "../../platform/frontmatter.ts";
import {
  PROOF_KINDS,
  type ProofWindow,
  RULE_VERDICTS,
  type Rule,
  type RuleError,
  type RuleProof,
  type RuleSet,
  type RuleTier,
  type RuleTrigger,
  type RuleVerdict,
} from "./rules.types.ts";

export type RuleSource = { name: string; tier: RuleTier; text: string };

const BARE_TRIGGERS = new Set(["pr-open", "commit", "push", "stop"]);

/** why: `tool(Write)` and `command(gh pr create)` carry an argument; the other four do not. */
function parseTrigger(raw: string): RuleTrigger | string {
  const bare = raw.trim();
  if (BARE_TRIGGERS.has(bare)) {
    return { kind: bare } as RuleTrigger;
  }
  const call = /^(tool|command)\(([^)]*)\)$/.exec(bare);
  const verb = call?.[1];
  const argument = call?.[2]?.trim();
  if (verb === undefined || argument === undefined || argument === "") {
    return `unknown trigger "${bare}" — use one of pr-open, commit, push, stop, tool(<name>), command(<pattern>)`;
  }
  return verb === "tool" ? { kind: "tool", name: argument } : { kind: "command", pattern: argument };
}

/**
 * `subagent(the-jury) since HEAD` → one proof.
 *
 * invariant: an unknown kind is an error, never a proof that silently never holds. A rule that cannot be
 * evaluated has to say so at read time, or it reads as protection and is not.
 */
function parseProof(raw: string): RuleProof | string {
  const [head, ...tail] = raw.trim().split(/\s+since\s+/i);
  const call = /^([a-z]+)\(([^)]*)\)$/.exec((head ?? "").trim());
  const kind = call?.[1];
  const value = call?.[2]?.trim();
  if (kind === undefined || !PROOF_KINDS.has(kind) || value === undefined || value === "") {
    return `unknown proof "${raw.trim()}" — use subagent(<type>), command(<pattern>), gate(<name>) or file(<glob>)`;
  }
  const windowRaw = (tail[0] ?? "head").trim().toLowerCase();
  if (windowRaw !== "head" && windowRaw !== "session") {
    return `unknown window "since ${windowRaw}" in "${raw.trim()}" — use since HEAD or since session`;
  }
  return { kind, value, since: windowRaw as ProofWindow } as RuleProof;
}

export function parseRule(source: RuleSource): { rule: Rule } | { error: RuleError } {
  const fail = (error: string) => ({ error: { name: source.name, tier: source.tier, error } });
  const { doc, error } = parseFrontmatterDoc(source.text);
  if (doc === null) {
    return fail(error ?? "unreadable");
  }

  const enabledRaw = doc.fields.enabled;
  const enabled = enabledRaw === undefined ? true : String(enabledRaw).trim() !== "false";

  const onRaw = doc.fields.on;
  if (typeof onRaw !== "string" || onRaw.trim() === "") {
    return fail("no `on:` trigger");
  }
  const trigger = parseTrigger(onRaw);
  if (typeof trigger === "string") {
    return fail(trigger);
  }

  const verdictRaw = doc.fields.otherwise;
  if (typeof verdictRaw !== "string" || !RULE_VERDICTS.has(verdictRaw.trim())) {
    return fail("`otherwise:` must be one of deny, ask, follow-up, warn");
  }

  const proofs: RuleProof[] = [];
  for (const entry of asList(doc.fields.require)) {
    const proof = parseProof(entry);
    if (typeof proof === "string") {
      return fail(proof);
    }
    proofs.push(proof);
  }
  // why: a disabled rule is allowed to declare nothing — it exists to switch a global off and to say why.
  if (proofs.length === 0 && enabled) {
    return fail("no `require:` proof, so nothing could ever satisfy this rule");
  }

  return {
    rule: {
      name: source.name,
      tier: source.tier,
      enabled,
      on: trigger,
      require: proofs,
      otherwise: verdictRaw.trim() as RuleVerdict,
      body: doc.body,
    },
  };
}

/**
 * Both tiers apply. A project rule of the same name replaces the global one, which is how the lesson tiers
 * already behave — union, deduplicated by id, nearer tier winning
 * ([/decisions/ad-040.md](/decisions/ad-040.md)). Writing the same rule once per repository is the friction this
 * removes.
 *
 * invariant: a rule switched off is kept, in `disabled`, so `doctor` can say which global a project turned off
 * rather than leaving the operator to guess why nothing fired.
 */
export function buildRuleSet(sources: readonly RuleSource[]): RuleSet {
  const byName = new Map<string, Rule>();
  const errors: RuleError[] = [];

  for (const tier of ["global", "project"] as const) {
    for (const source of sources.filter((candidate) => candidate.tier === tier)) {
      const parsed = parseRule(source);
      if ("error" in parsed) {
        errors.push(parsed.error);
        continue;
      }
      byName.set(parsed.rule.name, parsed.rule);
    }
  }

  const all = [...byName.values()];
  return {
    rules: all.filter((rule) => rule.enabled),
    disabled: all.filter((rule) => !rule.enabled),
    errors,
  };
}
