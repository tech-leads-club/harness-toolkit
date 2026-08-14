import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Refuses a union member that something reads and nothing writes.
 *
 * This repository has shipped that defect seven times: `attrs.permission`, `gate.outcome`, `policy.deny`,
 * `observe.rails` values, `format.enabled`, `LessonSource "manual"`, and `FailureCategory "infra"`. Every
 * instance reads as working, because the consumer's default — zero, false, an unentered branch — is a plausible
 * value. Tests pass, the report prints a truthful-looking `0`, and nobody can tell
 * ([/decisions/ad-041.md](/decisions/ad-041.md)).
 *
 * invariant: inventories are discovered, never registered. A registry would need an entry per union and the
 * missing entry is the same class of omission this exists to catch, so a new union type is covered by existing.
 */
const UNION_DECLARATION = /export type (\w+)\s*=\s*((?:\s*\|?\s*"[^"]+")+)\s*;/g;

export type Inventory = {
  typeName: string;
  file: string;
  members: string[];
};

export type WiringFinding = {
  typeName: string;
  member: string;
  declaredIn: string;
  consumedIn: string[];
};

export function parseInventories(file: string, text: string): Inventory[] {
  const out: Inventory[] = [];
  for (const match of text.matchAll(UNION_DECLARATION)) {
    const members = [...(match[2] ?? "").matchAll(/"([^"]+)"/g)]
      .map((member) => member[1])
      .filter((member): member is string => member !== undefined);
    if (members.length > 0 && match[1]) {
      out.push({ typeName: match[1], file, members });
    }
  }
  return out;
}

function quote(member: string): string {
  return member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * invariant: only unambiguous reads count. Membership in a `Set` or array literal is *not* a consumer, because
 * the same syntax builds an inventory, and treating it as a read produced noise on 66% of the corpus in the
 * first measurement.
 */
const CONSUMER_CONTEXT = /(?:===|!==|case\s+|includes\(|has\()\s*$/;

/**
 * A value position: assigned to a field, returned, produced by an arrow, or passed as an argument.
 *
 * hazard: a bare positional argument — `appendSpoolRecord(root, "audit", record)` — is a producer, and an
 * earlier draft classified it as a consumer because it sits after a comma. That single ambiguity accounted for
 * the only false positive in the whole corpus.
 *
 * hazard: the `=` alternative must not match the tail of `===`, and the `(` alternative must not match
 * `includes(`. Either hole reads a comparison as a write, which would let exactly the defect this check exists
 * to catch pass as wired. Consumer context is therefore tested first and wins.
 */
const PRODUCER_CONTEXT = /(?::|=>|return\s|\?|(?<![=!<>])=|\(|,|\[)\s*$/;

/**
 * Unions whose values legitimately arrive in the operator's `config.json`, so no source file writes them and
 * the absence of a producer is not a defect.
 *
 * invariant: listed with a reason and printed in the clean report. A silenced check that says nothing reads as a
 * passing check, which is the failure this repository recorded as AD-034.
 *
 * hazard: this is the only escape hatch, and it is per union rather than per member — an entry cannot hide a
 * dead member of an internal union, only state that a whole type is operator-supplied.
 */
export const CONFIG_FACING: ReadonlyMap<string, string> = new Map([
  ["AppendFilesMode", "policy.grind.appendFiles, set in .tlc/harness/config.json"],
  ["CommentMode", "policy.comments.mode, set in .tlc/harness/config.json"],
]);

export type MemberRole = "producer" | "consumer" | "ambiguous";

export function classifyOccurrence(before: string): MemberRole {
  if (CONSUMER_CONTEXT.test(before)) {
    return "consumer";
  }
  return PRODUCER_CONTEXT.test(before) ? "producer" : "ambiguous";
}

function rolesIn(text: string, member: string): { produced: boolean; consumed: boolean } {
  const needle = `"${member}"`;
  let produced = false;
  let consumed = false;
  let at = text.indexOf(needle);
  while (at >= 0) {
    const role = classifyOccurrence(text.slice(Math.max(0, at - 24), at));
    if (role === "producer") {
      produced = true;
    } else if (role === "consumer") {
      consumed = true;
    }
    at = text.indexOf(needle, at + needle.length);
  }
  return { produced, consumed };
}

export function producerPattern(member: string): RegExp {
  return new RegExp(`(?::|=>|return\\s|\\?|(?<![=!<>])=|\\(|,)\\s*"${quote(member)}"`);
}

export function consumerPattern(member: string): RegExp {
  return new RegExp(`(?:===|!==|case\\s+|includes\\(|has\\()\\s*"${quote(member)}"`);
}

export function findUnwired(
  inventories: readonly Inventory[],
  corpus: ReadonlyMap<string, string>,
): WiringFinding[] {
  const findings: WiringFinding[] = [];
  for (const inventory of inventories) {
    if (CONFIG_FACING.has(inventory.typeName)) {
      continue;
    }
    for (const member of inventory.members) {
      const consumedIn: string[] = [];
      let produced = false;
      for (const [file, text] of corpus) {
        if (!text.includes(`"${member}"`)) {
          continue;
        }
        const roles = rolesIn(text, member);
        if (roles.produced) {
          produced = true;
        }
        if (roles.consumed) {
          consumedIn.push(file);
        }
      }
      if (consumedIn.length > 0 && !produced) {
        findings.push({
          typeName: inventory.typeName,
          member,
          declaredIn: inventory.file,
          consumedIn,
        });
      }
    }
  }
  return findings;
}

function configFacingNote(): string[] {
  return [...CONFIG_FACING.entries()].map(([type, reason]) => `  not checked: ${type} — ${reason}`);
}

export function formatFindings(findings: readonly WiringFinding[], memberCount: number): string {
  if (findings.length === 0) {
    return [
      `check-wiring: ${memberCount} declared union members, every consumed member has a producer`,
      ...configFacingNote(),
    ].join("\n");
  }
  const lines = [
    `check-wiring: ${findings.length} of ${memberCount} declared union members are read and never written`,
    "",
  ];
  for (const finding of findings) {
    lines.push(`  ${finding.typeName}.${finding.member}  (declared in ${finding.declaredIn})`);
    for (const file of finding.consumedIn) {
      lines.push(`    read by ${file}`);
    }
    lines.push("    Either write it somewhere, or delete the member and the branches that read it.");
  }
  return lines.join("\n");
}

/**
 * why: git rather than a directory walk, so `.gitignore` decides what counts and `node_modules` or `dist` cannot
 * change the verdict.
 *
 * hazard: `ls-files` alone lists only the index, so a file added in the current change is invisible — and the
 * first run after adding `lesson.credit.ts` reported its brand-new union member as unproduced while the producer
 * sat in that very file. `--others --exclude-standard` adds not-yet-staged files while still honouring
 * `.gitignore`.
 */
export function trackedSourceFiles(cwd: string): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "src/**/*.ts", "bin/*.ts", "tools/*.ts"],
    { cwd, encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("__test__"));
}

function main(): void {
  const cwd = process.cwd();
  const files = trackedSourceFiles(cwd);
  const corpus = new Map<string, string>();
  const inventories: Inventory[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    corpus.set(file, text);
    inventories.push(...parseInventories(file, text));
  }
  const memberCount = inventories.reduce((total, inventory) => total + inventory.members.length, 0);
  const findings = findUnwired(inventories, corpus);
  const report = formatFindings(findings, memberCount);
  if (findings.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (import.meta.main) {
  main();
}
