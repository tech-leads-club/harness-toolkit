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
type ShellShape = {
  readonly prefix: readonly string[];
  /**
   * why this exists only on `gh pr create`: a draft is not yet open for review, so a rule gating `pr-open`
   * has no work to demand proof of. It is also the only way a proof that itself depends on the pull request
   * existing — `gh pr view`, for one — can ever run: open the draft, produce the proof against it, then
   * `gh pr ready`, which keeps its own gate ([/decisions/ad-118.md](/decisions/ad-118.md)).
   */
  readonly excludeIfAny?: readonly string[];
};

const SHELL_SHAPES: Record<"pr-open" | "commit" | "push" | "pr-merge", readonly ShellShape[]> = {
  "pr-open": [
    { prefix: ["gh", "pr", "create"], excludeIfAny: ["--draft", "-d"] },
    { prefix: ["gh", "pr", "ready"] },
  ],
  commit: [{ prefix: ["git", "commit"] }],
  push: [{ prefix: ["git", "push"] }],
  "pr-merge": [{ prefix: ["gh", "pr", "merge"] }],
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

/**
 * why a basename fallback: a token with no `/` of its own names an act, not a location — `build.sh` is the
 * same script whether it runs as `build.sh`, `./scripts/build.sh` or `/home/user/tools/scripts/build.sh`.
 * Confirmed live: a real `command(<script>)` proof stayed unsatisfied forever because every recorded
 * invocation ran the script by its full installed path, and a whole word is never `===` one of its own path
 * segments ([/decisions/ad-121.md](/decisions/ad-121.md)).
 *
 * why the `/` guard and not a bare suffix check: a token that already contains a `/` is the operator naming a
 * location, and a location is exact or it is the wrong one — treating `not_review.py` as a match for
 * `review.py` would turn a word boundary into a substring scan.
 */
function tokenMatches(word: string | undefined, token: string): boolean {
  if (word === undefined) {
    return false;
  }
  return word === token || (!token.includes("/") && word.endsWith(`/${token}`));
}

/**
 * why any starting index, not only 0: a wrapper in front of the real command — a proxy, `sudo`, `time`, `env
 * FOO=bar`, or one nobody has written yet — must not hide the act behind it. An anchored check goes silently
 * dead the moment anything sits in front of the verb it expects at word 0; a real rule stayed dead for exactly
 * that reason before this existed ([/decisions/ad-127.md](/decisions/ad-127.md)). Trailing words past the
 * phrase don't matter either: `gh pr create --fill --base main` is the same act as `gh pr create`.
 */
function findPhraseIndex(words: readonly string[], tokens: readonly string[]): number {
  if (tokens.length === 0) {
    return -1;
  }
  return words.findIndex((_, start) =>
    tokens.every((token, index) => tokenMatches(words[start + index], token)),
  );
}

function containsPhrase(words: readonly string[], tokens: readonly string[]): boolean {
  return findPhraseIndex(words, tokens) !== -1;
}

/**
 * why a second matcher, not one more `ShellShape`: `gh pr create` and `gh api repos/{o}/{r}/pulls` are the same
 * real-world act described in two different grammars — CLI subcommand words vs. a REST path and an HTTP method.
 * A pattern trigger was already documented as policy, not containment, precisely because of this escape
 * ([/decisions/ad-100.md](/decisions/ad-100.md)); this narrows the one instance of it this project has actually
 * seen exploited, without pretending to close the class ([/decisions/ad-128.md](/decisions/ad-128.md)).
 */
type ApiShape = {
  readonly lastSegment?: string;
  readonly containsSegment?: string;
  readonly adjacentPair?: readonly [string, string];
  readonly methods: readonly string[];
};

const API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-p",
  "--preview",
]);
const API_BODY_FLAGS = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);

/** why strip scheme+host and query: `gh api` accepts a bare path, a leading-slash path, or a full URL alike. */
function apiPathSegments(path: string): string[] {
  const withoutQuery = (path.split("?")[0] ?? "").replace(/^https?:\/\/[^/]+/, "");
  return withoutQuery.split("/").filter((segment) => segment.length > 0);
}

/**
 * why a hand-rolled scan and not `.find`: a value-taking flag's value (`-X POST`) must not be mistaken for the
 * endpoint, and `gh api` accepts both `<endpoint> [flags]` and `[flags] <endpoint>` — its own `--help` shows
 * both orders.
 */
function apiPathArgument(words: readonly string[]): string | undefined {
  const at = findPhraseIndex(words, ["gh", "api"]);
  if (at === -1) {
    return undefined;
  }
  const rest = words.slice(at + 2);
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined) {
      continue;
    }
    if (API_VALUE_FLAGS.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) {
      continue;
    }
    return word;
  }
  return undefined;
}

/**
 * why POST when a body flag is present with no explicit method: confirmed against `gh api --help`'s own text,
 * not assumed — "The default HTTP request method is GET normally and POST if any parameters were added."
 */
function inferredApiMethod(words: readonly string[]): string {
  const methodAt = words.findIndex((word) => word === "-X" || word === "--method");
  const explicit = methodAt === -1 ? undefined : words[methodAt + 1];
  if (explicit !== undefined) {
    return explicit.toUpperCase();
  }
  return words.some((word) => API_BODY_FLAGS.has(word)) ? "POST" : "GET";
}

function matchesApiShape(words: readonly string[], shape: ApiShape): boolean {
  const path = apiPathArgument(words);
  if (path === undefined) {
    return false;
  }
  const segments = apiPathSegments(path);
  const last = segments[segments.length - 1];
  if (shape.lastSegment !== undefined && last !== shape.lastSegment) {
    return false;
  }
  if (shape.containsSegment !== undefined && !segments.includes(shape.containsSegment)) {
    return false;
  }
  if (shape.adjacentPair !== undefined) {
    const [a, b] = shape.adjacentPair;
    if (!segments.some((segment, index) => segment === a && segments[index + 1] === b)) {
      return false;
    }
  }
  return shape.methods.includes(inferredApiMethod(words));
}

/**
 * why a phrase and not a word: an operator writes `command(gh pr review)`, meaning those words in that order.
 * Matching the raw string against the whole command would let a heredoc or an unrelated argument satisfy it.
 */
export function matchesPhrase(words: readonly string[], pattern: string): boolean {
  return containsPhrase(words, pattern.trim().split(/\s+/));
}

function matchesShape(words: readonly string[], shape: ShellShape): boolean {
  if (!containsPhrase(words, shape.prefix)) {
    return false;
  }
  return !shape.excludeIfAny?.some((flag) => words.includes(flag));
}

/**
 * why partial and not total: `commit` has no REST-endpoint equivalent an agent's normal workflow ever produces
 * — creating a commit through GitHub's git-database API is not a shape this project has observed in practice,
 * unlike the `pr-open`/`push`/`pr-merge` cases this record exists to close
 * ([/decisions/ad-128.md](/decisions/ad-128.md)).
 */
const API_SHAPES: Partial<Record<"pr-open" | "commit" | "push" | "pr-merge", readonly ApiShape[]>> = {
  "pr-open": [{ lastSegment: "pulls", methods: ["POST"] }],
  push: [{ adjacentPair: ["git", "refs"], methods: ["POST", "PATCH"] }],
};

function matchesAnyShape(
  words: readonly string[],
  kind: "pr-open" | "commit" | "push" | "pr-merge",
): boolean {
  if (SHELL_SHAPES[kind].some((shape) => matchesShape(words, shape))) {
    return true;
  }
  const apiShapes = API_SHAPES[kind] ?? [];
  return apiShapes.some((shape) => matchesApiShape(words, shape));
}

export function triggerMatches(trigger: RuleTrigger, context: TriggerContext): boolean {
  switch (trigger.kind) {
    case "stop":
      return context.event === "stop";
    case "tool":
      return context.toolName === trigger.name;
    case "pr-open":
    case "commit":
    case "push":
    case "pr-merge": {
      if (context.command === undefined) {
        return false;
      }
      return subCommands(context.command).some((words) => matchesAnyShape(words, trigger.kind));
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
