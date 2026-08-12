import type { GateFinding } from "./gate.types.ts";

export type LineRole = "count" | "test" | "assertion" | "other";

const DETAIL_MAX = 500;
const SUMMARY_MAX = 200;

// why: a tally is composed only of tally clauses. Matching "N fail" alone would swallow
// `1 fail — runCascade …`, which names the failure and must survive as a finding.
const TALLY =
  /\d+\s+(?:tests?|specs?|examples?)?\s*(?:fail(?:ed|ures?)?|pass(?:ed|ing)?|pending|skipped|todo|errors?)\b|(?:failures?|errors?)\s*=\s*\d+/gi;
const COUNT_LABEL = /^(?:tests?|specs?|failed|failures?|summary|results?)\b[:\s]*/i;
const COUNT_RESIDUE = /^[\s\d:;,|—–\-()=.✗×✕✖*]*$/;

// why: a structural marker identifies one failing test across frameworks — bun, TAP and `node --test`, go,
// jest, vitest, mocha. Checked before the weak `✗ name` form so `✗ 4 tests failed` stays a tally.
const STRONG_TEST = [
  /^\(fail\)\s*\S/i,
  /^not ok\s+\d+/i,
  /^---\s*FAIL:\s*\S/i,
  /^(?:FAIL|FAILED)\s+(?!\()\S/i,
];
const WEAK_TEST = /^[✗×✕✖]\s+\S/;

// hazard: a bare `error:` is NOT an assertion. `error: cannot find module` is a distinct failure, so it must
// not be folded into a neighbouring test as detail. Assertion vocabulary is the narrower, safer signal.
const ASSERTION_HINT =
  /(?:expect\(|toEqual|toBe\b|toMatch|toThrow|AssertionError|assert(?:ion)?\b|deep(?:Strict)?Equal|strictEqual|Expected\b|received\b|actual\b)/i;

function isCountOnly(line: string): boolean {
  if (!/\d/.test(line) || !/(?:fail|error)/i.test(line)) {
    return false;
  }
  const stripped = line.replace(COUNT_LABEL, " ").replace(TALLY, " ");
  return COUNT_RESIDUE.test(stripped);
}

export function classifyLine(line: string): LineRole {
  if (STRONG_TEST.some((pattern) => pattern.test(line))) {
    return "test";
  }
  if (isCountOnly(line)) {
    return "count";
  }
  if (WEAK_TEST.test(line)) {
    return "test";
  }
  return ASSERTION_HINT.test(line) ? "assertion" : "other";
}

type Failure = { summary: string; details: string[] };

// why: bun prints the assertion before the test line, TAP and `node --test` after. One walk covers both by
// buffering assertions seen before any test line and attaching them to the next one opened.
function groupFailures(lines: string[]): { failures: Failure[]; firstCount: string | null } {
  const failures: Failure[] = [];
  const pending: string[] = [];
  let firstCount: string | null = null;
  let current: Failure | null = null;

  for (const line of lines) {
    switch (classifyLine(line)) {
      case "count":
        firstCount ??= line;
        break;
      case "test": {
        const failure: Failure = { summary: line, details: pending.splice(0) };
        failures.push(failure);
        current = failure;
        break;
      }
      case "assertion":
        if (current) {
          current.details.push(line);
        } else {
          pending.push(line);
        }
        break;
      default: {
        // why: an unrecognised hit is a failure in its own right, so unknown formats degrade to today's
        // behaviour minus the noise rather than to silence. It opens a group so a following assertion
        // attaches to it instead of starting a second item.
        const failure: Failure = { summary: line, details: pending.splice(0) };
        failures.push(failure);
        current = failure;
      }
    }
  }

  // hazard: an assertion with no test line ever seen is still a real failure. Dropping the buffer here is
  // how a genuine failure would disappear.
  if (pending.length > 0) {
    failures.push({ summary: pending[0] as string, details: pending.slice(1) });
  }
  return { failures, firstCount };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupe(failures: Failure[]): Failure[] {
  const byKey = new Map<string, Failure>();
  for (const failure of failures) {
    const key = normalize(failure.summary);
    const seen = byKey.get(key);
    if (seen) {
      seen.details.push(...failure.details);
      continue;
    }
    byKey.set(key, { summary: failure.summary, details: [...failure.details] });
  }
  return [...byKey.values()];
}

function toFinding(failure: Failure): GateFinding {
  const detail = [...new Set(failure.details)].join("\n").slice(0, DETAIL_MAX);
  return detail
    ? { summary: failure.summary.slice(0, SUMMARY_MAX), detail }
    : { summary: failure.summary.slice(0, SUMMARY_MAX) };
}

/**
 * One finding per failure. A tally is never a finding, two views of the same failure are one item, and the
 * assertion that explains a test travels with it as detail rather than as a second problem to fix.
 *
 * invariant: never returns an empty list while the gate failed, and never merges two distinct summaries —
 * the consumer instructs an agent to fix every item, so a lost failure and an invented one are both harmful.
 */
export function findingsFromLines(lines: string[], exitCode: number, max: number): GateFinding[] {
  const { failures, firstCount } = groupFailures(lines);
  const unique = dedupe(failures);

  if (unique.length === 0) {
    // why: the gate did fail, so something must be reported. The tally becomes detail instead of being
    // promoted to a finding of its own.
    const fallback: GateFinding = { summary: `gate exited with code ${exitCode}` };
    return firstCount ? [{ ...fallback, detail: firstCount.slice(0, DETAIL_MAX) }] : [fallback];
  }

  if (unique.length <= max) {
    return unique.map(toFinding);
  }

  // hazard: a silent cap reads as "that was everything". The omitted count is part of the finding list.
  // why: the disclosure costs one slot, so it only appears once there are more failures than slots — which
  // makes the omitted count always two or more, never one.
  const kept = unique.slice(0, Math.max(1, max - 1)).map(toFinding);
  const omitted = unique.length - kept.length;
  return [...kept, { summary: `…and ${omitted} more failures in the gate output` }];
}

const SOURCE_EXT = "ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|swift|php|sh|sql";
// why: the runner prints the file it failed in — `test at src/x.test.ts:12:1`, or a file:// URL inside a stack
// frame. Those paths are evidence. The changed files from the diff are only context, and were being presented
// as the thing to fix.
const PATH_IN_OUTPUT = new RegExp(
  `(?:file://)?((?:[A-Za-z]:)?[\\w./~@+-]*[\\w-]\\.(?:${SOURCE_EXT}))(?=[:)\\s,'"\`]|$)`,
  "g",
);

/**
 * hazard: a test runner colours its output, and an escape ends `[39m` — the escape character itself does not match
 * the path pattern but `39m` does, so a coloured `src/x.test.ts` came out as `39msrc/x.test.ts`. The autopilot then
 * told the agent, by name, to go and fix a file that does not exist. Seen in this repository's own gate output.
 */
export function stripAnsi(text: string): string {
  // why: the escape is built from its char code rather than written literally, so the pattern can name it without
  // putting a control character in the source — which is what the linter is right to refuse.
  const escape = String.fromCharCode(27);
  return text.replaceAll(new RegExp(`${escape}\\[[0-9;]*[A-Za-z]`, "g"), "");
}

/**
 * Source files the gate output itself names, in first-appearance order, deduplicated.
 *
 * why: `projectDir` is taken so an absolute path inside the repository collapses onto the relative spelling of
 * the same file. Node prints both forms for one failure — `test at src/x.test.ts:12` and a `file:///…` stack
 * frame — and without this they would read as two separate places to look.
 */
export function filesFromOutput(outputTail: string, projectDir: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const prefix = `${projectDir.replace(/\/+$/, "")}/`;

  for (const match of stripAnsi(outputTail).matchAll(PATH_IN_OUTPUT)) {
    const raw = match[1];
    if (!raw) {
      continue;
    }
    // hazard: a path outside the project stays as printed — the runner named it, so hiding it would lose the
    // only pointer the reader has.
    const path = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    files.push(path);
  }
  return files;
}
