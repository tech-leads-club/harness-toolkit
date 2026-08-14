import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * A silenced diagnostic is a decision, and a decision with no stated reason is indistinguishable from someone
 * making a red gate go away. Biome 2 already requires text after the colon, so `biome-ignore lint/x: y` parses —
 * this is what stops `y` from being the reason ([/decisions/ad-051.md](/decisions/ad-051.md)).
 */
export type Suppression = {
  file: string;
  line: number;
  directive: string;
  reason: string;
};

export type SuppressionFinding = Suppression & { detail: string };

/** The three ways a diagnostic gets silenced in this repo's languages. `@ts-nocheck` disables a whole file. */
const DIRECTIVE_PATTERN =
  /(?:^|\s)(?:\/\/|\/\*|\*|#)?\s*(biome-ignore(?:-all|-start|-end)?|@ts-ignore|@ts-expect-error|@ts-nocheck)\b([^\n]*)/;

/**
 * invariant: the words this project already requires on any comment that stays. A suppression is a comment that
 * survives review, so it answers the same question — see `comment-policy.service.ts`.
 */
export const DECLARED_PREFIXES = ["why:", "hazard:", "invariant:"] as const;

const MIN_REASON_WORDS = 4;

/**
 * hazard: the first version of this check reported three findings, and all three were string literals in the
 * comment-policy tests — a test asserting that tool directives are exempt has to contain one. A checker whose
 * findings are all noise is a checker somebody switches off, so the directive has to be in a real comment: after a
 * comment marker, and outside any quoted string on that line.
 */
export function isInComment(text: string, at: number): boolean {
  // hazard: counting quotes was the first attempt and it broke on this checker's own tests, where a directive sits
  // inside a single-quoted string that itself contains double quotes. Nested quotes of a different kind must not
  // toggle the state, so the opening character is tracked rather than the count.
  let quote: string | null = null;
  for (let index = 0; index < at; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "#" || (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*"))) {
      return true;
    }
  }
  // why: a continuation line of a block comment has no marker of its own, only the leading asterisk.
  return quote === null && /^\s*\*/.test(text.slice(0, at));
}

export function parseSuppression(file: string, line: number, text: string): Suppression | null {
  const match = DIRECTIVE_PATTERN.exec(text);
  if (!match || match.index === undefined) {
    return null;
  }
  const at = text.indexOf(match[1] ?? "", match.index);
  if (!isInComment(text, at)) {
    return null;
  }
  const directive = match[1] ?? "";
  const tail = (match[2] ?? "").replace(/\*\/\s*$/, "").trim();
  // why: biome puts the rule name before the colon and the reason after it; the ts directives have no rule, so
  // everything after the directive is the reason. Splitting on the first colon covers both.
  const reason = directive.startsWith("biome-ignore")
    ? (tail.split(":").slice(1).join(":") ?? "").trim()
    : tail.replace(/^[:\-\s]+/, "").trim();
  return { file, line, directive, reason };
}

export function judge(suppression: Suppression): SuppressionFinding | null {
  const { reason } = suppression;
  if (suppression.directive === "@ts-nocheck") {
    return {
      ...suppression,
      detail: "@ts-nocheck disables a whole file; suppress the single diagnostic instead",
    };
  }
  if (reason.length === 0) {
    return { ...suppression, detail: "no reason given" };
  }
  const lowered = reason.toLowerCase();
  if (!DECLARED_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return {
      ...suppression,
      detail: `the reason must open with ${DECLARED_PREFIXES.join(", ")} — got "${reason.slice(0, 40)}"`,
    };
  }
  const body = reason.slice(reason.indexOf(":") + 1).trim();
  if (body.split(/\s+/).filter((word) => word.length > 0).length < MIN_REASON_WORDS) {
    return {
      ...suppression,
      // hazard: the point of the floor. `biome-ignore lint/x: why: needed` parses and says nothing.
      detail: `the reason is ${MIN_REASON_WORDS} words or fewer — say what breaks without the suppression`,
    };
  }
  return null;
}

export function findSuppressions(files: readonly string[], read = readFileSync): SuppressionFinding[] {
  const findings: SuppressionFinding[] = [];
  for (const file of files) {
    const lines = String(read(file, "utf8")).split("\n");
    for (const [index, text] of lines.entries()) {
      const suppression = parseSuppression(file, index + 1, text);
      if (suppression === null) {
        continue;
      }
      const finding = judge(suppression);
      if (finding !== null) {
        findings.push(finding);
      }
    }
  }
  return findings;
}

export function formatFindings(findings: readonly SuppressionFinding[], scanned: number): string {
  if (findings.length === 0) {
    return `check-suppressions: ok (0 unjustified in ${scanned} files)`;
  }
  const lines = findings.map(
    (finding) => `  ${finding.file}:${finding.line}  [${finding.directive}]  ${finding.detail}`,
  );
  return [`check-suppressions: ${findings.length} unjustified suppression(s)`, ...lines].join("\n");
}

/**
 * hazard: `__test__` is scanned like everything else — a test that suppresses a diagnostic is suppressing it, and
 * excluding tests is how the rule would come to be routed around. What keeps the fixtures quiet is `isInComment`,
 * not an exclusion.
 */
export function trackedFiles(cwd: string): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "src/**/*.ts", "bin/*.ts", "tools/*.ts"],
    { cwd, encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function main(): void {
  const cwd = process.cwd();
  const files = trackedFiles(cwd);
  const findings = findSuppressions(files);
  console.log(formatFindings(findings, files.length));
  if (findings.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
