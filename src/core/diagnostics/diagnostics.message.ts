/**
 * The one place a denial describes what it checked, so a blocked agent — or a human reading it later — can
 * tell in one step whether a finding is its own turn's work, without an external session reading source code
 * by hand ([/decisions/ad-120.md](/decisions/ad-120.md)).
 *
 * invariant: pure string formatting. No git, no I/O — every caller already resolved `shaRoot`/`sha` before
 * reaching here, so this never spends a process it does not need.
 */

export const WHY_POINTER = "Run `tlc harness why` for the full diagnostic.";

/**
 * why: `footer` is the full multi-line block appended to a denial's message body; `summary` is the single
 * bounded line stored on `Decision.diagnostic` and rendered by `tlc harness why`. One computation, two
 * shapes, so the wording of the shared head line can never drift between them.
 */
export type Diagnostic = { footer: string; summary: string };

function reproductionLines(sha: string, files: readonly { file: string }[]): string[] {
  const distinct = [...new Set(files.map((entry) => entry.file))].slice(0, 5);
  return distinct.map((file) => `Reproduce: git diff ${sha} -- ${file}`);
}

/**
 * why: a right-looking sha computed against a wrong directory is indistinguishable from a right sha computed
 * against the right one unless both are named together ([/decisions/ad-120.md](/decisions/ad-120.md)).
 */
export function diffDiagnostic(
  shaRoot: string,
  sha: string | null,
  files: readonly { file: string }[],
): Diagnostic {
  const head = sha === null ? `Checked ${shaRoot} — no HEAD yet.` : `Checked ${shaRoot} at ${sha}.`;
  const repro = sha === null ? [] : reproductionLines(sha, files);
  const footer = [head, ...repro, WHY_POINTER].join("\n");
  const summary = repro[0] === undefined ? head.replace(/\.$/, "") : `${head.replace(/\.$/, "")} · ${repro[0]}`;
  return { footer, summary };
}

/**
 * why: a lint/test/docs gate failure has no diff to reproduce — the `TRIED: <command>` line the caller
 * already prints is its own reproduction. Only the directory is new information.
 */
export function rootDiagnostic(shaRoot: string): Diagnostic {
  const head = `Checked ${shaRoot}.`;
  return { footer: [head, WHY_POINTER].join("\n"), summary: head.replace(/\.$/, "") };
}
