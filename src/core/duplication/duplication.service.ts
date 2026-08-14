import type { AddedLine } from "../../platform/git.ts";
import { matchesSyntax } from "../comment-policy/comment-policy.service.ts";
import { syntaxFor } from "../comment-policy/comment-syntax.store.ts";

/**
 * A run of lines this turn added that already exists somewhere else in the project.
 *
 * why: the harness watches for the agent solving a problem the codebase already solved — the failure an operator
 * notices weeks later as two copies drifting apart. It is a diff-scoped question, like the comment gate: only
 * what this turn wrote is judged, and what was already duplicated is not this turn's to answer for
 * ([/decisions/ad-071.md](/decisions/ad-071.md)).
 *
 * invariant: lines, never syntax. Nothing here parses a language, so the rail behaves the same in Go, Python and
 * TypeScript — the constraint the comment syntax catalog exists to satisfy
 * ([/decisions/ad-058.md](/decisions/ad-058.md)).
 */
export type Duplication = {
  file: string;
  line: number;
  /** Where the same run already lives. */
  matchFile: string;
  matchLine: number;
  runLength: number;
};

/**
 * hazard: below six lines the matches are punctuation. Measured on this repository at a four-line window, the
 * top hits were import blocks and `} catch { return null; }` — true duplicates, and none of them a defect. Six
 * is the length at which a match started being something worth reading.
 */
export const MIN_RUN = 6;

/** why: a line that is only a brace, a bracket or a keyword carries no design, so it neither starts nor extends a run. */
export const MIN_LINE_CHARS = 8;

/**
 * why: whitespace and the trailing comma are the two things a paste changes without changing the code, so the
 * comparison ignores both. Nothing else is rewritten: renaming an identifier makes it a different line, on
 * purpose, because a rail that matched through renames would report every similar-shaped function.
 */
export function normaliseLine(text: string): string | null {
  const collapsed = text.trim().replace(/\s+/g, " ").replace(/,$/, "");
  return collapsed.length < MIN_LINE_CHARS ? null : collapsed;
}

/**
 * hazard: the first calibration run reported 137 duplications at a six-line window and the top of the list was
 * every import block in the repository — `import assert from "node:assert/strict"` next to `import { test } from
 * "node:test"` is identical in every test file and is not a defect. The words below open a dependency
 * declaration in most languages, which keeps this a vocabulary rule rather than a parser.
 */
const DEPENDENCY_LINE = /^\s*(?:import|from|export|require|#include|use|using|package|namespace|open)\b/;

/** invariant: a comment is not code. Two identical licence headers are not a duplicated implementation. */
export function isCodeLine(text: string, file: string): boolean {
  if (DEPENDENCY_LINE.test(text)) {
    return false;
  }
  const syntax = syntaxFor(file);
  return syntax === null ? true : !matchesSyntax(text, syntax);
}

/**
 * hazard: with dependency lines excluded the calibration still reported 116 runs, and reading the top of the list
 * showed every one of them was *data*: a re-export name list, a config object literal, a type's field
 * declarations, a test fixture. Repeated shape is what those are for. A run has to carry operations — a call, an
 * assignment, a branch, a return — before two copies of it mean anything, and a majority of the run has to carry
 * them or one `foo()` inside a literal would qualify it.
 */
const OPERATIONAL = /[(=]|\b(?:if|for|while|switch|return|throw|await|new|catch)\b/;

export const MIN_OPERATIONAL_RATIO = 0.5;

function operationalEnough(window: readonly { key: string }[]): boolean {
  const operations = window.filter((entry) => OPERATIONAL.test(entry.key)).length;
  return operations >= Math.ceil(window.length * MIN_OPERATIONAL_RATIO);
}

export type SourceLine = { file: string; line: number; text: string };

export type RunSite = { file: string; line: number };

/**
 * hazard: one site per run was not enough. The project index contains the lines this turn added, so a run whose
 * first occurrence happened to be the new copy compared equal to itself and every duplication vanished — the
 * calibration reported zero at every window length, which is what exposed it. Two sites are the minimum that can
 * answer "is there a copy somewhere other than here".
 */
export const SITES_PER_RUN = 2;

export type RunIndex = Map<string, RunSite[]>;

function runKey(window: readonly string[]): string {
  return window.join("\n");
}

/**
 * why: one entry per distinct run, keyed by its text. The first place a run is seen wins, so a report names one
 * prior home rather than every copy — an operator asked to look at eleven identical sites reads none of them.
 */
export function indexRuns(lines: readonly SourceLine[], minRun = MIN_RUN): RunIndex {
  const index: RunIndex = new Map();
  const usable = lines
    .map((entry) => ({
      ...entry,
      key: isCodeLine(entry.text, entry.file) ? normaliseLine(entry.text) : null,
    }))
    .map((entry) => (entry.key === null ? null : { file: entry.file, line: entry.line, key: entry.key }));

  for (let start = 0; start + minRun <= usable.length; start += 1) {
    const window = usable.slice(start, start + minRun);
    // hazard: a run has to be contiguous in the file as well as in this array, or a match spans a gap the reader
    // cannot see. Two files concatenated into one array would otherwise produce a run that exists nowhere.
    if (window.some((entry) => entry === null)) {
      continue;
    }
    const solid = window as { file: string; line: number; key: string }[];
    const head = solid[0] as { file: string; line: number; key: string };
    if (solid.some((entry, offset) => entry.file !== head.file || entry.line !== head.line + offset)) {
      continue;
    }
    if (!operationalEnough(solid)) {
      continue;
    }
    const key = runKey(solid.map((entry) => entry.key));
    const sites = index.get(key) ?? [];
    if (sites.length < SITES_PER_RUN) {
      index.set(key, [...sites, { file: head.file, line: head.line }]);
    }
  }
  return index;
}

/**
 * why: the added lines are indexed the same way the project is, then intersected. A run this turn added that the
 * project already had, somewhere the turn did not write, is the finding.
 */
export function findDuplications(
  added: readonly AddedLine[],
  project: RunIndex,
  minRun = MIN_RUN,
): Duplication[] {
  const found: Duplication[] = [];
  const reported = new Set<string>();
  for (const [key, sites] of indexRuns(added, minRun)) {
    const where = sites[0] as RunSite;
    // invariant: a run matching itself is not a duplication, and the project index contains the very lines this
    // turn added — so the answer is the first site that is somewhere else.
    const prior = (project.get(key) ?? []).find(
      (site) => site.file !== where.file || site.line !== where.line,
    );
    if (prior === undefined) {
      continue;
    }
    const seen = `${where.file}:${where.line}`;
    if (reported.has(seen)) {
      continue;
    }
    reported.add(seen);
    found.push({
      file: where.file,
      line: where.line,
      matchFile: prior.file,
      matchLine: prior.line,
      runLength: minRun,
    });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function duplicationMessage(hits: readonly Duplication[]): string {
  return [
    `BLOCKED: this turn added ${hits.length} run(s) of ${MIN_RUN}+ lines that already exist in this project.`,
    "TRIED: compared the lines this turn added against the rest of the repository, ignoring",
    "comments, blank lines and whitespace. A run already duplicated before this turn is not counted.",
    "NEED: call the existing code, or extract what both need. If the duplication is deliberate —",
    "the two will diverge, or the shared form would couple them — say which, in one line, and continue.",
    "",
    ...hits
      .slice(0, 10)
      .map((hit) => `${hit.file}:${hit.line}  already at  ${hit.matchFile}:${hit.matchLine}`),
  ].join("\n");
}

/**
 * hazard: hook latency is a product property ([/decisions/ad-012.md](/decisions/ad-012.md)), and the honest
 * version of this scan reads every tracked file on every stop. These bounds are what keep a large repository
 * from paying for the rail in wall-clock; the report says when one was reached, because a scan that silently
 * covered half a project reads as a clean answer.
 */
export const MAX_SCAN_FILES = 2000;
export const MAX_SCAN_BYTES = 8_000_000;

export type ProjectScan = { index: RunIndex; filesRead: number; truncated: boolean };

export type ReadFile = (relativePath: string) => string | null;

export function scanProject(files: readonly string[], readFile: ReadFile, minRun = MIN_RUN): ProjectScan {
  const lines: SourceLine[] = [];
  let bytes = 0;
  let filesRead = 0;
  let truncated = false;
  for (const file of files) {
    if (filesRead >= MAX_SCAN_FILES || bytes >= MAX_SCAN_BYTES) {
      truncated = true;
      break;
    }
    const text = readFile(file);
    if (text === null) {
      continue;
    }
    bytes += text.length;
    filesRead += 1;
    for (const [index, line] of text.split("\n").entries()) {
      lines.push({ file, line: index + 1, text: line });
    }
  }
  return { index: indexRuns(lines, minRun), filesRead, truncated };
}
