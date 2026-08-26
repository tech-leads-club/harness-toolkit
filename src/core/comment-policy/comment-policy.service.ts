import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddedLine } from "../../platform/git.ts";
import { listAddedLines } from "../../platform/git.ts";
import type { CommentMode } from "../policy/policy.types.ts";
import type { CommentFinding } from "./comment-policy.types.ts";
import { firstLeak, leakReason } from "./comment-resolvability.ts";
import { syntaxFor } from "./comment-syntax.store.ts";
import type { CommentSyntax } from "./comment-syntax.types.ts";

/**
 * hazard: this was three hand-written regexes and a ten-extension list. `#` starts a comment in shell and Python
 * but not in TypeScript, where it starts a private field — and markdown inside a template literal made
 * `## Heading` read as seven added comments. Both cases are now decided by the catalog, which says which
 * delimiters a given extension actually has, and a Python docstring is covered because the catalog carries it
 * ([/decisions/ad-058.md](/decisions/ad-058.md)).
 *
 * invariant: a file the catalog does not know produces no findings and is counted as unknown. Guessing a
 * delimiter for an unrecognised language is how `#` came to mean "comment" in TypeScript.
 */
export function matchesSyntax(text: string, syntax: CommentSyntax): boolean {
  const trimmed = text.trimStart();
  if (trimmed === "") {
    return false;
  }
  if (syntax.line.some((prefix) => prefix !== "" && trimmed.startsWith(prefix))) {
    return true;
  }
  for (const [open, close] of syntax.block) {
    if (trimmed.startsWith(open)) {
      return true;
    }
    // hazard: a lone closer ends a block and is not itself a comment line, so counting it would extend every
    // block by one. A symmetric fence — a Python docstring — is exempt, because its closer is also its opener.
    if (open !== close && trimmed.startsWith(close)) {
      return false;
    }
  }
  // hazard: `*` continues a C-family block and `**` is markdown bold. The regex this replaced spelled that
  // `\*(?![*/])`, and dropping the guard made `**Provider:** \`x\`` in a template literal read as narration —
  // caught by the test written for that exact regression.
  return syntax.middle.some((middle) => trimmed.startsWith(middle) && !trimmed.startsWith(middle + middle));
}

const TOOL_DIRECTIVE =
  /^\s*(?:\/\/|\/\*|\*|#)\s*(?:biome-ignore|eslint|@ts-|prettier-ignore|noqa|type:|shellcheck|!)/;
/**
 * why: a codegen tool's own banner ("Code generated ... DO NOT EDIT", Phabricator's `@generated`) is not
 * agent narration — no operator wrote it and no agent chose the words, the generator stamps it on every
 * regeneration. Flagging it asked an agent to delete text that would just reappear on the next
 * `terramate generate`/`go generate`/etc., and deleting it by hand is what those tools' own drift checks
 * exist to catch.
 */
const GENERATED_FILE_MARKER = /@generated\b|\bgenerat\w*\b.{0,40}\bdo[\s-]?not[\s-]?edit\b/i;
const DECLARED_REASON = /^\s*(?:\/\/|\/\*|\*|#)\s*(?:why|hazard|invariant):\s*\S/i;
const CLOSER_OR_CONTINUATION = /^\s*(?:\*\/|\*|\/\/)/;

export const COMMENT_MARKERS = ["why:", "hazard:", "invariant:"] as const;

/**
 * why: `file` decides everything now, so an empty one resolves to no syntax rather than to a permissive union of
 * every delimiter the harness has heard of. The facade keeps this signature; the scanner always has a real path.
 */
export function isCommentLine(text: string, file = ""): boolean {
  const syntax = file === "" ? null : syntaxFor(file);
  if (syntax === null) {
    return false;
  }
  return matchesSyntax(text, syntax) && !TOOL_DIRECTIVE.test(text) && !GENERATED_FILE_MARKER.test(text);
}

/**
 * invariant: no `codePaths` param. Taking one needs `policy.loader.ts` → `policy.defaults.ts` →
 * `duplication.service.ts`, which imports this module back for `matchesSyntax` — an import cycle. The
 * caller scopes by `codePaths` first; this filters what's left by syntax alone.
 */
export function filterCommentTargets(relativePaths: string[]): string[] {
  return relativePaths.filter((path) => syntaxFor(path) !== null);
}

export function declaresReason(text: string): boolean {
  return DECLARED_REASON.test(text);
}

const DECLARATION =
  /^\s*(?:(?:export|declare|public|private|protected|readonly|static|async|abstract)\s+)*(?:class|function|const|let|var|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)|^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(<]/;

// invariant: attachment is decided by position, the same way every JSDoc tool decides it. A `/** */`
// floating inside a function body documents nothing, so it is judged as an inline comment instead.
export function attachedIdentifier(codeLine: string | undefined): string | null {
  const match = codeLine === undefined ? null : DECLARATION.exec(codeLine);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "get",
  "gets",
  "has",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "return",
  "returns",
  "set",
  "sets",
  "that",
  "the",
  "then",
  "this",
  "to",
  "true",
  "when",
  "which",
  "with",
]);

function words(text: string): string[] {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

export const MIN_INFORMATIVE_WORDS = 3;

// invariant: a doc comment addresses the caller, so the question is whether it carries information the
// identifier does not. Exempting the form outright would make `/** */` an escape hatch.
export function isInformativeDoc(commentText: string, identifier: string): boolean {
  const named = new Set(words(identifier));
  const remaining = words(commentText.replace(/^[\s/*]+|[\s*/]+$/g, "")).filter(
    (word) => !named.has(word) && !STOPWORDS.has(word),
  );
  return new Set(remaining).size >= MIN_INFORMATIVE_WORDS;
}

// invariant: a marker sits on the first line of a comment, so continuation lines are part of the same
// block and are not judged on their own.
export function groupCommentBlocks(added: AddedLine[]): AddedLine[][] {
  const blocks: AddedLine[][] = [];
  let block: AddedLine[] = [];

  for (const line of added) {
    if (!isCommentLine(line.text, line.file)) {
      block = [];
      continue;
    }
    const previous = block.at(-1);
    if (previous && previous.file === line.file && previous.line === line.line - 1) {
      block.push(line);
      continue;
    }
    block = [line];
    blocks.push(block);
  }

  return blocks;
}

// hazard: judging by the head alone lets one marker cover any length of text below it.
export const MAX_DECLARED_LINES = 4;

export type NextCodeLine = (file: string, line: number) => string | undefined;

type Verdict = { violates: boolean; reason: string };

// hazard: `*/` is not a comment line, so a block ends one line before its closer. The lookup skips the
// closer and any continuation line to reach the declaration, here rather than in each resolver.
function declarationAfter(file: string, tailLine: number, nextCodeLine: NextCodeLine): string | undefined {
  for (let line = tailLine + 1; line <= tailLine + 4; line += 1) {
    const text = nextCodeLine(file, line);
    if (text === undefined) {
      continue;
    }
    if (text.trim() === "" || CLOSER_OR_CONTINUATION.test(text)) {
      continue;
    }
    return text;
  }
  return undefined;
}

function judge(block: AddedLine[], mode: CommentMode, nextCodeLine?: NextCodeLine): Verdict {
  const head = block[0] as AddedLine;
  const tail = block.at(-1) as AddedLine;

  if (head.text.trimStart().startsWith("/**") && nextCodeLine) {
    const identifier = attachedIdentifier(declarationAfter(head.file, tail.line, nextCodeLine));
    if (identifier !== null) {
      const body = block.map((line) => line.text).join(" ");
      if (mode === "strict") {
        return { violates: true, reason: "comment added this turn" };
      }
      if (!isInformativeDoc(body, identifier)) {
        return { violates: true, reason: `doc comment only restates ${identifier}` };
      }
      // why: a doc comment is prose a reader meets first, so it is the surface where a dead citation costs most.
      const docLeak = mode === "resolvable" ? firstLeak(body) : null;
      return docLeak === null
        ? { violates: false, reason: "" }
        : { violates: true, reason: leakReason(docLeak) };
    }
  }

  if (mode === "strict") {
    return { violates: true, reason: "comment added this turn" };
  }
  if (!declaresReason(head.text)) {
    return { violates: true, reason: "undeclared comment added this turn" };
  }
  if (block.length > MAX_DECLARED_LINES) {
    return { violates: true, reason: `declared comment runs past ${MAX_DECLARED_LINES} lines` };
  }
  // invariant: resolvability is asked last, and only of a comment that already earned its place. A comment with
  // no declared reason is refused for that, and adding a second refusal to the same block would report one
  // problem as two ([/decisions/ad-070.md](/decisions/ad-070.md)).
  if (mode === "resolvable") {
    const leak = firstLeak(block.map((line) => line.text).join(" "));
    if (leak !== null) {
      return { violates: true, reason: leakReason(leak) };
    }
  }
  return { violates: false, reason: "" };
}

export function findAddedComments(
  added: AddedLine[],
  mode: CommentMode = "declared",
  nextCodeLine?: NextCodeLine,
): CommentFinding[] {
  const findings: CommentFinding[] = [];
  for (const block of groupCommentBlocks(added)) {
    if (block[0] === undefined) {
      continue;
    }
    const verdict = judge(block, mode, nextCodeLine);
    if (verdict.violates) {
      const head = block[0];
      findings.push({
        file: head.file,
        line: head.line,
        reason: verdict.reason,
        text: head.text.trim().slice(0, 120),
      });
    }
  }
  return findings;
}

// hazard: documenting an existing export touches only the comment, so the declaration it attaches to is
// absent from the diff and has to be read from disk.
function diskLineReader(projectDir: string): NextCodeLine {
  const cache = new Map<string, string[]>();
  return (file, line) => {
    let lines = cache.get(file);
    if (lines === undefined) {
      try {
        lines = readFileSync(join(projectDir, file), "utf8").split("\n");
      } catch {
        lines = [];
      }
      cache.set(file, lines);
    }
    return lines[line - 1];
  };
}

export async function scanAddedComments(
  projectDir: string,
  relativePaths: string[],
  mode: CommentMode = "declared",
  base = "HEAD",
): Promise<CommentFinding[]> {
  const added = await listAddedLines(projectDir, relativePaths, base);
  return findAddedComments(added, mode, diskLineReader(projectDir));
}

export function commentViolationMessage(hits: CommentFinding[], mode: CommentMode = "declared"): string {
  const need =
    mode === "resolvable"
      ? [
          // why: the fix for an unresolvable comment is not deletion. The passage usually carries a true fact
          // wrapped in the session's vantage — restating it at HEAD keeps the fact and drops the transcript.
          "NEED: restate each line below so a reader at HEAD can check it without the transcript of",
          "this session — state the present behaviour, or state the counterfactual (`without X, Y`).",
          "Delete it when nothing survives that restatement.",
        ]
      : mode === "strict"
        ? [
            "NEED: delete every line below. This project does not accept agent-added comments.",
            "If one is genuinely warranted, say so in your reply and let the operator write it.",
          ]
        : [
            `NEED: delete each line below, or restate it as ${COMMENT_MARKERS.join(" / ")} when it`,
            "records a non-obvious why, a hazard, or an external constraint. Narrating what the code",
            "does is not a reason.",
          ];
  return [
    `BLOCKED: this turn added ${hits.length} comment(s).`,
    "TRIED: compared the lines this turn added against the commit it started from; pre-existing",
    "comments are never counted.",
    "Each entry is one comment, reported at its first line.",
    ...need,
    "Tool directives (biome-ignore, @ts-, noqa, shellcheck, shebang) and generated-file banners",
    '(@generated, "generated ... do not edit") are exempt.',
    "",
    ...hits.slice(0, 20).map((h) => `${h.file}:${h.line}  ${h.text}`),
  ].join("\n");
}

/**
 * why: this fires at edit-time, before stop has run — nothing is blocked yet, so it must not say `BLOCKED`
 * like `commentViolationMessage` correctly does. Reusing that wording here would claim a refusal this call
 * cannot make and never sees whether the agent honours.
 */
export function commentEditAdvisory(hits: CommentFinding[], mode: CommentMode = "declared"): string {
  const marker = mode === "strict" ? "" : ` as ${COMMENT_MARKERS.join(" / ")}`;
  return [
    `HEADS UP: this edit added ${hits.length} comment(s) that would block the stop later.`,
    `Fix now while it's cheap — delete it, or restate it${marker} if it records a non-obvious reason.`,
    "",
    ...hits.slice(0, 20).map((h) => `${h.file}:${h.line}  ${h.text}`),
  ].join("\n");
}
