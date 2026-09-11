import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setProjectScopedEnv } from "../../platform/env-scope.ts";
import { gateSessionsDir, projectStateDir } from "../../platform/paths.ts";
import { NO_OUTPUT_CAPTURED } from "../../platform/process.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";
import { findingsFromLines } from "./gate.findings.ts";
import { GATE_SCHEMA, type GateFinding, type LastGateArtifact } from "./gate.types.ts";

export const OUTPUT_TAIL_MAX = 8000;
export const FINDINGS_MAX = 8;

const FAIL_HINT =
  /(?:\bFAIL(?:ED)?\b|\bERROR\b|Error:|error\[|AssertionError|\bpanic:|✗|×|✕|✖|failures?\s*[:=]\s*[1-9])/i;

export function lastGatePath(root: string, sessionKey: string): string {
  return join(gateSessionsDir(root), `${sanitizeSegment(sessionKey)}.json`);
}

export function gateReportPath(root: string): string {
  return join(projectStateDir(root), "gate-report.json");
}

export function trimOutputTail(combined: string, max = OUTPUT_TAIL_MAX): string {
  const text = combined.trim();
  if (!text) {
    return "";
  }
  return text.length <= max ? text : text.slice(-max);
}

export function clearGateReport(root: string): void {
  const path = gateReportPath(root);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readReportFindings(reportPath: string): GateFinding[] | null {
  const raw = readJson<unknown>(reportPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const findings = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    return null;
  }
  const out: GateFinding[] = [];
  for (const item of findings) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const summary = (item as { summary?: unknown }).summary;
    if (typeof summary !== "string" || !summary.trim()) {
      continue;
    }
    const detail = (item as { detail?: unknown }).detail;
    const id = (item as { id?: unknown }).id;
    out.push({
      summary: summary.trim().slice(0, 200),
      detail: typeof detail === "string" ? detail.slice(0, 500) : undefined,
      id: typeof id === "string" ? id : undefined,
    });
    if (out.length >= FINDINGS_MAX) {
      break;
    }
  }
  return out.length > 0 ? out : null;
}

// hazard: this used to emit one finding per matched line, so a single failing test arrived as three problems
// to fix — the assertion header, the test name and the tally `1 fail`. The consumer instructs an agent to fix
// every item, so grouping is not cosmetic. Matching stays as permissive as before; only what happens to the
// matched lines changed.
export function extractFindingsFromOutput(
  outputTail: string,
  exitCode: number,
  max = FINDINGS_MAX,
): GateFinding[] {
  const lines = outputTail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(">"));
  const hits = lines.filter((line) => FAIL_HINT.test(line));
  const picked = hits.length > 0 ? hits : lines.slice(-max);
  return findingsFromLines(picked, exitCode, max);
}

export function writeLastGate(args: {
  root: string;
  sessionKey: string;
  gate: string;
  exitCode: number;
  command: string[];
  files: string[];
  durationMs: number;
  output: string;
  reportPath?: string;
  inputsHash?: string;
}): LastGateArtifact {
  const outputTail = trimOutputTail(args.output);
  const fromReport = args.reportPath ? readReportFindings(args.reportPath) : null;
  const emptyOutput = !outputTail || outputTail === NO_OUTPUT_CAPTURED;
  const findings =
    fromReport ??
    (args.exitCode === 0
      ? []
      : emptyOutput
        ? [{ summary: `gate exited with code ${args.exitCode}` }]
        : extractFindingsFromOutput(outputTail, args.exitCode));
  const artifact: LastGateArtifact = {
    schema: GATE_SCHEMA,
    gate: args.gate,
    exitCode: args.exitCode,
    passed: args.exitCode === 0,
    command: args.command,
    files: [...args.files],
    durationMs: args.durationMs,
    ts: new Date().toISOString(),
    outputTail,
    findings,
    // invariant: read here rather than passed in, so every gate records it and a gate added later cannot forget.
    // Core never spells a variable name — `platform/env-scope.ts` owns the list, because `check-boundaries`
    // forbids a vendor identifier under `core/` ([/decisions/ad-060.md](/decisions/ad-060.md)).
    scopedEnv: setProjectScopedEnv(),
    ...(args.inputsHash ? { inputsHash: args.inputsHash } : {}),
  };
  const path = lastGatePath(args.root, args.sessionKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

export function readLastGate(root: string, sessionKey: string): LastGateArtifact | null {
  return readJson<LastGateArtifact>(lastGatePath(root, sessionKey));
}

const GATE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function pruneGateSessions(root: string, options: { now?: number; maxAgeMs?: number } = {}): number {
  const dir = gateSessionsDir(root);
  if (!existsSync(dir)) {
    return 0;
  }
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? GATE_SESSION_MAX_AGE_MS;
  let pruned = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const path = join(dir, name);
    const artifact = readJson<LastGateArtifact>(path);
    // why: an unreadable or unparseable ts (a torn read racing a concurrent writer, or a shape from
    // before this field existed) means "unknown", not "old" — the sibling handoff pruner
    // ([/decisions/ad-122.md](/decisions/ad-122.md)) already treats doubt as a reason to keep a file, not
    // delete it, and a false delete here costs a neighbour session's cached gate result.
    const age = artifact ? now - Date.parse(artifact.ts) : Number.NaN;
    if (Number.isNaN(age) || age < maxAgeMs) {
      continue;
    }
    // why: a file already gone between `readdirSync` and this `unlinkSync` needs no retry — the same
    // silent swallow `clearGateReport` already uses for its own single-file unlink, above.
    try {
      unlinkSync(path);
      pruned += 1;
    } catch {}
  }
  return pruned;
}

export function computeGateFingerprint(artifact: LastGateArtifact): string {
  const raw = JSON.stringify({
    gate: artifact.gate,
    exitCode: artifact.exitCode,
    files: [...artifact.files].sort(),
    findings: artifact.findings.map((f) => f.summary).sort(),
  });
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
