import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_KIND_TO_OBS_KIND,
  type ObsKind,
  resolveObsLevel,
} from "../src/core/observability/observability.types.ts";
import { ACTIVITY_PLANES, TOOL_KINDS } from "../src/core/turn/turn.activity.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Violation = { rule: string; detail: string };

/**
 * A consumer of the obs bus: the kinds it counts and the planes it reads.
 *
 * why: `ObsKind` being a closed union is a schema. A contract also says which plane a kind lands on, and that is
 * what the idle-turn counter got wrong — it read the signal plane while every kind it counted resolves to debug
 * ([/decisions/ad-065.md](/decisions/ad-065.md)).
 */
export type ObsConsumer = { name: string; kinds: readonly string[]; planes: readonly string[] };

export const CONSUMERS: ObsConsumer[] = [
  { name: "turn.activity", kinds: [...TOOL_KINDS], planes: [...ACTIVITY_PLANES] },
];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__test__") {
        out.push(...listFiles(full));
      }
      continue;
    }
    if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// why: an emit site is a `kind:` literal reaching `recordObs`, plus every kind the inbound mapping produces from
// a provider event. The mapping is a producer even though no line names the kind next to `recordObs`.
export function emittedKinds(root: string): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const kind of Object.values(EVENT_KIND_TO_OBS_KIND)) {
    sites.set(kind, ["EVENT_KIND_TO_OBS_KIND"]);
  }
  for (const dir of ["src/entrypoints", "src/core", "bin", "tools"]) {
    for (const file of listFiles(join(root, dir))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bkind:\s*"([a-z][a-z._]*)"/g)) {
        const kind = match[1] as string;
        const at = relative(root, file);
        const existing = sites.get(kind) ?? [];
        if (!existing.includes(at)) {
          sites.set(kind, [...existing, at]);
        }
      }
    }
  }
  return sites;
}

export function planeOf(kind: string): string {
  // invariant: the real resolver, never a copy. A plane rule that changes here cannot leave the check stale.
  return resolveObsLevel(kind as ObsKind) === "signal" ? "obs.jsonl" : "debug.jsonl";
}

export function check(
  root: string,
  consumers: readonly ObsConsumer[],
  declared: readonly string[],
): { violations: Violation[]; orphans: string[] } {
  const emitted = emittedKinds(root);
  const violations: Violation[] = [];
  const consumed = new Set(consumers.flatMap((consumer) => consumer.kinds));

  for (const consumer of consumers) {
    for (const kind of consumer.kinds) {
      if (!emitted.has(kind)) {
        violations.push({
          rule: "consumed-never-emitted",
          detail: `${consumer.name} counts \`${kind}\`, which no producer emits`,
        });
        continue;
      }
      const plane = planeOf(kind);
      if (!consumer.planes.includes(plane)) {
        violations.push({
          rule: "plane-mismatch",
          detail: `${consumer.name} counts \`${kind}\`, which lands on ${plane}, but reads only ${consumer.planes.join(", ")}`,
        });
      }
    }
  }

  // why: reported, never failed. A kind nothing reads costs a write per event and may be a rail half-built, which
  // is a judgement for the operator rather than a build failure.
  const orphans = declared.filter((kind) => emitted.has(kind) && !consumed.has(kind)).sort();
  return { violations, orphans };
}

export function report(outcome: { violations: Violation[]; orphans: string[] }): {
  text: string;
  ok: boolean;
} {
  const lines: string[] = [];
  for (const violation of outcome.violations) {
    lines.push(`  [${violation.rule}]  ${violation.detail}`);
  }
  const ok = outcome.violations.length === 0;
  lines.unshift(
    ok
      ? `check-obs-contract: every counted kind is emitted and read on a plane it lands on`
      : `check-obs-contract: ${outcome.violations.length} contract violation(s)`,
  );
  if (outcome.orphans.length > 0) {
    lines.push(`  emitted and read by no declared consumer: ${outcome.orphans.join(", ")}`);
  }
  return { text: lines.join("\n"), ok };
}

if (import.meta.main) {
  const { SIGNAL_KINDS } = await import("../src/core/observability/observability.types.ts");
  const declared = [...new Set([...Object.values(EVENT_KIND_TO_OBS_KIND), ...SIGNAL_KINDS])];
  const outcome = check(repoRoot, CONSUMERS, declared);
  const printed = report(outcome);
  console.log(printed.text);
  process.exit(printed.ok ? 0 : 1);
}
