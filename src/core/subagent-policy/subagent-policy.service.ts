import type { Decision } from "../../contracts/decision.ts";
import type { EffortLevel } from "../../contracts/effort.ts";
import { compareEffort, isEffortLevel } from "../../contracts/effort.ts";
import { forProvider, type ProviderScoped } from "../policy/policy.types.ts";
import {
  candidateModelBlocked,
  isModelAllowlisted,
  shouldDenyParentFast,
} from "./subagent-policy.parent-model.ts";

export type EvaluateSubagentSpawnArgs = {
  provider: string;
  sessionKey: string;
  projectDir: string;
  model: string;
  modelParams?: unknown;
  effort?: string;
  allowedModels: ProviderScoped<string>;
  blockedPatterns: ProviderScoped<string>;
  minEffort: EffortLevel | null;
  requireModel: boolean;
  enforceAllowlist: boolean;
  blockParentFast: boolean;
  blockMode?: "deny" | "ask";
};

/** The key an operator edits. Named in the refusal, because the list is theirs and nothing else supplies one. */
export const ALLOWLIST_KEY = "subagents.allowedModels";

/**
 * hazard: the refusal was `Use one of: <list>` and named no source. An operator whose own config read
 * `"allowedModels": []` was being refused by a shipped list, opened the file, saw an empty array, and concluded
 * that empty means none — then offered to switch the rail off. The list has no other source now, and the message
 * says which key holds it ([/decisions/ad-053.md](/decisions/ad-053.md)).
 */
export function allowlistRefusal(model: string, allowed: readonly string[]): string {
  const base = `"${model}" is not in \`${ALLOWLIST_KEY}\`. Use one of: ${allowed.join(", ")}.`;
  // why: `inherit` is not a model name — it means the parent's model — so listing slugs answers a question it did
  // not ask. It is a value the operator may put on the list, and saying so is the route that works (AD-047).
  return model === "inherit"
    ? `${base} \`inherit\` is a value that list may contain; add it there to permit it.`
    : base;
}

export function evaluateSubagentSpawn(args: EvaluateSubagentSpawnArgs): Decision {
  const patterns = forProvider(args.blockedPatterns, args.provider) ?? [];
  const block = (reason: string, userNote: string): Decision =>
    args.blockMode === "ask" ? { kind: "ask", reason, userNote } : { kind: "deny", reason, userNote };

  const blockedBy = candidateModelBlocked(args.model, patterns, args.modelParams);
  if (blockedBy) {
    return block(
      `Do not use *-fast models. Pattern hit: ${blockedBy}.`,
      `Blocked subagent model "${args.model}" (matches ${blockedBy}).`,
    );
  }

  if (args.requireModel && !args.model.trim()) {
    return block(
      "Set model explicitly on every Task spawn. Do not omit model.",
      "Subagent spawned without an explicit model.",
    );
  }

  const allowed = forProvider(args.allowedModels, args.provider);
  // hazard: an empty list used to deny every model, because `[]` is not `null`. With no shipped fallback that
  // would refuse every spawn from a rule naming nothing — which is what the reader who reported this mistook for
  // a bug, correctly. `doctor` reports the combination instead ([/decisions/ad-053.md](/decisions/ad-053.md)).
  if (
    args.enforceAllowlist &&
    args.model &&
    allowed !== null &&
    allowed.length > 0 &&
    !isModelAllowlisted(args.model, allowed)
  ) {
    return block(
      allowlistRefusal(args.model, allowed),
      `Subagent model "${args.model}" is not on the allowlist.`,
    );
  }

  if (
    args.minEffort &&
    args.effort !== undefined &&
    isEffortLevel(args.effort) &&
    compareEffort(args.effort, args.minEffort) < 0
  ) {
    return block(
      `Subagent effort "${args.effort}" is below the required minimum "${args.minEffort}".`,
      `Raise the subagent effort to at least "${args.minEffort}" and retry.`,
    );
  }

  if (
    shouldDenyParentFast({
      enabled: args.blockParentFast,
      projectDir: args.projectDir,
      sessionKey: args.sessionKey,
      patterns,
    })
  ) {
    return block(
      "Parent Fast mode is forbidden for Task/subagent spawns. Turn Fast off on the parent model and retry.",
      "Blocked subagent spawn: parent conversation is in Fast mode.",
    );
  }

  return { kind: "allow" };
}

export {
  candidateModelBlocked,
  isModelAllowlisted,
  modelMatchesBlocked,
  readParentModelState,
  shouldDenyParentFast,
  upsertParentModelState,
} from "./subagent-policy.parent-model.ts";
