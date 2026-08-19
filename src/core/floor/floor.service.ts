import type { Decision } from "../../contracts/decision.ts";
import { isInside, isScratch, isSecretPath, resolveTarget } from "./floor.paths.ts";
import { checkPolicySurface } from "./floor.policy-surface.ts";
import { type ShellSegment, type ShellWord, tokenizeShell } from "./floor.tokenize.ts";
import { verbOf } from "./floor.verb.ts";

export type FloorRule =
  | "machine-control"
  | "secret-access"
  | "unprovable-destruction"
  | "history-rewrite"
  | "outside-project-destruction"
  | "policy-surface-write"
  | "unprovable-execution";

export type FloorInput = {
  projectDir: string;
  toolName?: string | undefined;
  filePath?: string | undefined;
  command?: string | undefined;
  isReadEvent?: boolean | undefined;
};

const DESTRUCTIVE_VERBS = new Set(["dd", "rm", "rmdir", "shred", "truncate"]);
const MACHINE_VERBS = new Set(["halt", "poweroff", "reboot", "shutdown"]);
const READER_VERBS = new Set(["base64", "cat", "head", "less", "more", "od", "strings", "tail", "xxd"]);
const READING_TOOLS = new Set(["Read", "Edit", "MultiEdit", "NotebookEdit"]);
const EXPANDING_VERBS = new Set([".", "eval", "source"]);
const SHELLS = new Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"]);

/**
 * why: a verb whose job is to bring bytes from the network. The set is the reason the rule can be stated at all —
 * a program that arrives over the wire does not exist when the decision is made
 * ([/decisions/ad-074.md](/decisions/ad-074.md)).
 */
const FETCH_VERBS = new Set(["aria2c", "curl", "fetch", "http", "httpie", "https", "wget"]);

/**
 * The link-local services that hand out cloud credentials over HTTP.
 *
 * why: `secret-access` matched by path, so `~/.aws/credentials` was refused while the address returning the same
 * credential was allowed. A credential is not always a file.
 */
const METADATA_HOSTS = ["169.254.169.254", "169.254.170.2", "100.100.100.200", "metadata.google.internal"];

/**
 * invariant: verbs that speak to the network, and nothing else. `grep -rn 169.254.169.254 .` searches this
 * repository for a literal string and stays allowed — scoping to the verb is what keeps it that way.
 */
const NETWORK_VERBS = new Set([...FETCH_VERBS, "nc", "ncat", "socat", "telnet", "lwp-request"]);

function namesFetcher(text: string): boolean {
  return [...FETCH_VERBS].some((verb) => new RegExp(`\\b${verb}\\b`).test(text));
}

/**
 * A program assembled from a network fetch and handed to a shell.
 *
 * hazard: measured against the floor before this existed, all four spellings were allowed — and each one hands
 * the shell a payload that satisfies every other floor rule by containing nothing the gate can see. The wrapper
 * deletes nothing, reads nothing and forces nothing; whatever arrives does
 * ([/decisions/ad-074.md](/decisions/ad-074.md)).
 */
function fetchedProgramReachesShell(command: string, segments: readonly ShellSegment[]): boolean {
  // hazard: the tokenizer splits on `;`, `|` and `&` alike, so carrying a flag across segments treated
  // `curl --version && bash ./scripts/deploy.sh` as a download piped to a shell. Requiring a literal pipe keeps
  // every real `curl … | bash` and drops a sequence that merely mentions a fetcher — a false positive is
  // expensive in a rule with no switch ([/decisions/ad-034.md](/decisions/ad-034.md)).
  const piped = command.includes("|");
  let upstreamFetches = false;
  for (const segment of segments) {
    const head = verbOf(segment.words);
    if (!head) {
      continue;
    }
    const { verb, args } = head;

    // 1. a pipeline whose upstream fetched and whose downstream is a shell
    if (piped && upstreamFetches && SHELLS.has(verb)) {
      return true;
    }

    if (SHELLS.has(verb) || EXPANDING_VERBS.has(verb)) {
      for (const word of args) {
        // 2. process substitution: `bash <(curl …)`
        // 3. and 4. an unresolved word that names a fetcher — `sh -c "$(curl …)"`, `eval "$(curl …)"`
        const substitution = word.text.includes("<(") || word.unresolved;
        if (substitution && namesFetcher(word.text)) {
          return true;
        }
      }
    }

    upstreamFetches = FETCH_VERBS.has(verb);
  }
  return false;
}

// why: `bash script.sh` runs a file this gate cannot see, which is a coverage limit rather than evasion.
// `bash -c "..."` carries the command inline, which is the case worth refusing.
function buildsCommandAtRuntime(verb: string, args: ShellWord[]): boolean {
  return EXPANDING_VERBS.has(verb) || (SHELLS.has(verb) && args.some((word) => word.text === "-c"));
}

function reason(rule: FloorRule, detail: string): string {
  return [
    `FLOOR: ${detail}`,
    "This is a floor rule — it has no config switch, because a limit an agent can turn off is not a limit.",
    "Restate what you need and let the operator decide; do not work around this.",
    `rule=${rule}`,
  ].join("\n");
}

// why: the rule was already written into the reason prose as `rule=<name>`. Carrying it structurally as well is
// what lets a refusal be counted and attributed without parsing English
// ([/decisions/ad-027.md](/decisions/ad-027.md)).
function denial(rule: FloorRule, detail: string, note: string): Decision {
  return {
    kind: "deny",
    reason: reason(rule, detail),
    userNote: `Floor rule ${rule}: ${note}`,
    rule,
  };
}

function isMkfs(verb: string): boolean {
  return verb === "mkfs" || verb.startsWith("mkfs.");
}

function isDangerousVerb(token: string): boolean {
  const verb = token.split("/").pop() ?? token;
  return DESTRUCTIVE_VERBS.has(verb) || MACHINE_VERBS.has(verb) || isMkfs(verb);
}

function hidesDestructiveVerb(segment: ShellSegment): boolean {
  return segment.words.some((word) => word.text.split(/\s+/).some(isDangerousVerb));
}

function pathArgs(args: ShellWord[]): ShellWord[] {
  return args.filter((word) => !word.text.startsWith("-") && word.text !== "");
}

function checkShell(input: FloorInput): Decision {
  const command = input.command;
  if (!command) {
    return { kind: "allow" };
  }

  const segments = tokenizeShell(command);

  // invariant: asked before the rest. A fetched program satisfies every other rule by containing nothing this
  // gate can read, so checking the wrapper first and the payload never is the order that let it through.
  if (fetchedProgramReachesShell(command, segments)) {
    return denial(
      "unprovable-execution",
      "This runs a program fetched over the network, which does not exist for this gate to check. Download it to a file, read it, then run that file.",
      "fetched program piped to a shell",
    );
  }

  for (const segment of segments) {
    const head = verbOf(segment.words);
    if (!head) {
      continue;
    }
    const { verb, args } = head;

    // hazard: `eval "rm -rf /"` and `bash -c "rm -rf /"` build their command at runtime, so the head
    // word does not describe what will run. Reasoning about the nested quoting is the weak-parser
    // trap — refuse the segment instead of interpreting it. Scanning words is only sound here: doing
    // it for any opaque segment flags an `rm` quoted as data somewhere in a long script.
    if (buildsCommandAtRuntime(verb, args) && hidesDestructiveVerb(segment)) {
      return denial(
        "unprovable-destruction",
        "A destructive verb appears inside a command this gate cannot expand, so its target cannot be established. Run it directly with a literal path instead.",
        "hidden destructive verb",
      );
    }

    if (MACHINE_VERBS.has(verb)) {
      return denial("machine-control", `\`${verb}\` controls the machine, not the project.`, verb);
    }

    if (verb === "git" && args.some((word) => word.text === "push")) {
      const forced = args.some((word) => word.text === "--force" || word.text === "-f");
      if (forced) {
        return denial(
          "history-rewrite",
          "`git push --force` discards remote commits that are not in your history. Use --force-with-lease, which refuses when the remote moved.",
          "force push",
        );
      }
    }

    const destructive = DESTRUCTIVE_VERBS.has(verb) || isMkfs(verb);
    if (!destructive) {
      continue;
    }

    const targets = pathArgs(args);

    // hazard: an opaque segment or an unresolved word means the target is unknown. The floor must
    // prove the target is safe, not prove it is dangerous, so unknown resolves to denied.
    if (segment.opaque || targets.some((word) => word.unresolved) || targets.length === 0) {
      return denial(
        "unprovable-destruction",
        `\`${verb}\` was called with a target this gate cannot resolve, so its safety cannot be established. Re-run it with a literal path inside the project.`,
        `unresolvable ${verb}`,
      );
    }

    for (const word of targets) {
      const resolved = resolveTarget(input.projectDir, word.text);
      if (!isInside(input.projectDir, resolved) && !isScratch(resolved)) {
        return denial(
          "outside-project-destruction",
          `\`${verb}\` targets ${resolved}, which is outside the project and outside scratch space.`,
          `${verb} outside project`,
        );
      }
    }
  }

  // hazard: the guard that used to defend this surface keyed off tool names, so a single shell line went
  // around it. The rule belongs here, where the decision is made before any policy is read.
  const surface = checkPolicySurface(input.projectDir, command, segments);
  if (surface.kind === "deny") {
    // invariant: the remedy comes from the branch that denied, so a read refusal names how to read and a write
    // refusal names who may write. One fixed tail on both handed write advice to an agent trying to read
    // ([/decisions/ad-047.md](/decisions/ad-047.md)).
    const remedy =
      surface.remedy ??
      "Set a gate command with `tlc harness gate test-command` or `gate lint-command`, and run policy changes from your own terminal rather than from inside this session.";
    return denial("policy-surface-write", `${surface.detail} ${remedy}`, surface.note);
  }

  return checkShellSecrets(segments, input.projectDir);
}

function checkShellSecrets(segments: ShellSegment[], projectDir: string): Decision {
  for (const segment of segments) {
    const head = verbOf(segment.words);
    if (!head) {
      continue;
    }
    if (NETWORK_VERBS.has(head.verb)) {
      const target = head.args.map((word) => word.text).join(" ");
      const endpoint = METADATA_HOSTS.find((host) => target.includes(host));
      if (endpoint !== undefined) {
        return denial(
          "secret-access",
          `${endpoint} is the instance metadata service, and \`${head.verb}\` would copy the credentials it returns into the transcript.`,
          `read of ${endpoint}`,
        );
      }
    }
    if (!READER_VERBS.has(head.verb)) {
      continue;
    }
    for (const word of pathArgs(head.args)) {
      if (word.unresolved) {
        continue;
      }
      const resolved = resolveTarget(projectDir, word.text);
      if (isSecretPath(resolved)) {
        return denial(
          "secret-access",
          `\`${head.verb}\` would read ${resolved} into the transcript. Credentials do not belong in an agent's context.`,
          `read of ${resolved}`,
        );
      }
    }
  }
  return { kind: "allow" };
}

function checkFile(input: FloorInput): Decision {
  const filePath = input.filePath;
  if (!filePath) {
    return { kind: "allow" };
  }
  const reads =
    input.isReadEvent === true || (input.toolName !== undefined && READING_TOOLS.has(input.toolName));
  if (!reads) {
    return { kind: "allow" };
  }
  const resolved = resolveTarget(input.projectDir, filePath);
  if (!isSecretPath(resolved)) {
    return { kind: "allow" };
  }
  return denial(
    "secret-access",
    `${resolved} holds credentials, and reading it would copy them into the transcript.`,
    `read of ${resolved}`,
  );
}

// invariant: this function takes no policy. Adding a config parameter here would turn the floor into
// a guardrail, which is the one thing it must not be.
export function evaluateFloor(input: FloorInput): Decision {
  const file = checkFile(input);
  if (file.kind !== "allow") {
    return file;
  }
  return checkShell(input);
}
