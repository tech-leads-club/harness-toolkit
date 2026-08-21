/**
 * Whether a rule's trigger fires on this event.
 *
 * invariant: pure, and it never reads a host payload. It takes the published event shape, so a rule written once
 * fires the same way on every provider ([/decisions/ad-004.md](/decisions/ad-004.md)).
 *
 * hazard: a shell trigger cannot be a substring test against the whole command. `x && gh pr create` is a pull
 * request being opened, and a heredoc body containing the words `gh pr create` is a document. `tokenizeShell`
 * separates both and is the only splitter in this repository — a second regex here would be the duplication that
 * makes one of them wrong later ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
import { tokenizeShell } from "../floor/floor.tokenize.ts";
import type { Rule, RuleTrigger } from "./rules.types.ts";

/**
 * What the harness reads to decide whether a trigger fires. A subset of the event, named so the vocabulary is
 * visible: adding a trigger that needs a new field has to widen this deliberately.
 */
export type TriggerContext = {
  event: string;
  toolName?: string;
  command?: string;
};

/**
 * why a set per trigger rather than one pattern the operator writes: `pr-open` has to mean the same thing in
 * every repository, or a rule copied between them silently stops firing. An operator who wants their own shape
 * writes `command(<pattern>)`.
 */
const SHELL_SHAPES: Record<"pr-open" | "commit" | "push", readonly string[][]> = {
  "pr-open": [
    ["gh", "pr", "create"],
    ["gh", "pr", "ready"],
  ],
  commit: [["git", "commit"]],
  push: [["git", "push"]],
};

/**
 * invariant: `tokenizeShell` already declines to emit segments from a heredoc body, so a body is never mistaken
 * for a command and a command after one is still seen. Measured both ways on
 * `cat <<EOF > runbook.md\ngh pr create --fill\nEOF` and on the same with a real command after the terminator:
 * identical output.
 *
 * hazard: the first version of this called `splitHeredocs` first as well. It changed nothing — the mutation that
 * removed it survived, which is what exposed it as dead rather than as untested
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
function subCommands(command: string): string[][] {
  return tokenizeShell(command)
    .map((segment) => segment.words.map((word) => word.text))
    .filter((words) => words.length > 0);
}

/** why prefix rather than equality: `gh pr create --fill --base main` is the same act as `gh pr create`. */
function startsWithShape(words: readonly string[], shape: readonly string[]): boolean {
  return shape.every((token, index) => words[index] === token);
}

/**
 * why a phrase and not a word: an operator writes `command(gh pr review)`, meaning those words in that order.
 * Matching the raw string against the whole command would let a heredoc or an unrelated argument satisfy it.
 */
function matchesPhrase(words: readonly string[], pattern: string): boolean {
  const phrase = pattern.trim().split(/\s+/);
  if (phrase.length === 0) {
    return false;
  }
  return words.some((_, start) => phrase.every((token, index) => words[start + index] === token));
}

export function triggerMatches(trigger: RuleTrigger, context: TriggerContext): boolean {
  switch (trigger.kind) {
    case "stop":
      return context.event === "stop";
    case "tool":
      return context.toolName === trigger.name;
    case "pr-open":
    case "commit":
    case "push": {
      if (context.command === undefined) {
        return false;
      }
      const shapes = SHELL_SHAPES[trigger.kind];
      return subCommands(context.command).some((words) =>
        shapes.some((shape) => startsWithShape(words, shape)),
      );
    }
    default: {
      if (context.command === undefined) {
        return false;
      }
      return subCommands(context.command).some((words) => matchesPhrase(words, trigger.pattern));
    }
  }
}

/** invariant: a disabled rule never fires. It exists to switch a global off and to record why. */
export function firingRules(rules: readonly Rule[], context: TriggerContext): Rule[] {
  return rules.filter((rule) => rule.enabled && triggerMatches(rule.on, context));
}
