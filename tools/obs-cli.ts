import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreFacade } from "../src/core/index.ts";
import { readSignalEvents } from "../src/core/observability/observability.store.ts";
import { DEFAULT_OBS, type ObsEvent } from "../src/core/observability/observability.types.ts";
import { loadPolicy } from "../src/core/policy/policy.loader.ts";
import { emitJson, takeJsonFlag } from "../src/platform/cli-output.ts";
import { projectStateDir } from "../src/platform/paths.ts";

export const NO_EVENTS = "(no signal events yet)";

export function liveText(events: readonly ObsEvent[]): string {
  const lines = events.map((e) => `${e.ts}\t${e.kind}\t${JSON.stringify(e.attrs).slice(0, 220)}`);
  return lines.join("\n") || NO_EVENTS;
}

export function liveJson(events: readonly ObsEvent[]): { count: number; events: readonly ObsEvent[] } {
  return { count: events.length, events };
}

export function limitFrom(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * hazard: this sorted by filename. A session id is a UUID, so alphabetical order has no relation to time — on
 * this machine it picked a session from thirteen days earlier whose every counter was zero, which reads exactly
 * like "the harness did nothing". `tlc harness obs report` is the command an operator runs to find out what the
 * harness did, and it was answering about the wrong session.
 *
 * invariant: newest by modification time, and ties break on the name so the answer is deterministic. An
 * unreadable entry is skipped rather than treated as the newest.
 */
export function latestSessionId(root: string): string | null {
  const sessions = join(projectStateDir(root), "sessions");
  if (!existsSync(sessions)) {
    return null;
  }
  const dated = readdirSync(sessions)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return { name, at: statSync(join(sessions, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; at: number } => entry !== null)
    .sort((a, b) => (a.at === b.at ? a.name.localeCompare(b.name) : a.at - b.at));
  const last = dated.at(-1)?.name;
  return last ? last.replace(/\.json$/, "") : null;
}

function main(argv: string[]): void {
  const { json, rest } = takeJsonFlag(argv);
  const root = process.env.TLC_PROJECT_DIR ?? process.cwd();
  const cmd = (rest[0] ?? "live").toLowerCase();
  const arg = rest[1];

  if (cmd === "live") {
    const events = readSignalEvents(root, DEFAULT_OBS.signalPath, limitFrom(arg, 40));
    if (json) {
      emitJson(liveJson(events));
    } else {
      console.log(liveText(events));
    }
    process.exit(0);
  }

  if (cmd === "events") {
    const events = readSignalEvents(root, DEFAULT_OBS.signalPath, limitFrom(arg, 50));
    // why: the flag's contract is one parseable value per invocation, so the stream of lines collapses
    // into a single array. Without the flag this stays newline-delimited, as every existing caller expects.
    if (json) {
      emitJson(liveJson(events));
    } else {
      for (const event of events) {
        console.log(JSON.stringify(event));
      }
    }
    process.exit(0);
  }

  // why: the two planes, because the signal plane carries the refusals and the debug plane carries the allows.
  // Neither alone answers "did the harness just do that?" ([/decisions/ad-062.md](/decisions/ad-062.md)).
  if (cmd === "why") {
    const limit = limitFrom(arg, 10);
    const events = ["obs.jsonl", "debug.jsonl"].flatMap((plane) => readSignalEvents(root, plane, 400));
    const decisions = coreFacade.observability.decisionsFrom(events).slice(0, limit);
    if (json) {
      emitJson({ count: decisions.length, decisions });
    } else {
      console.log(coreFacade.observability.whyText(decisions));
    }
    process.exit(0);
  }

  if (cmd === "report") {
    const conversationId = arg ?? latestSessionId(root);
    if (!conversationId) {
      if (json) {
        emitJson({ error: "no sessions yet" });
      } else {
        console.error("no sessions yet");
      }
      process.exit(1);
    }
    const rollup = coreFacade.observability.getRollup(root, conversationId);
    if (!rollup) {
      if (json) {
        emitJson({ error: `no rollup for session: ${conversationId}`, session: conversationId });
      } else {
        console.error(`no rollup for session: ${conversationId}`);
      }
      process.exit(1);
    }
    const markdown = coreFacade.observability.sessionReportMarkdown(rollup);
    const reportsDir = join(projectStateDir(root), "reports");
    mkdirSync(reportsDir, { recursive: true });
    const path = join(reportsDir, `${conversationId}.md`);
    writeFileSync(path, markdown);
    if (json) {
      emitJson({ session: conversationId, path, rollup });
    } else {
      console.log(markdown);
      console.log(`\nWrote ${path}`);
    }
    process.exit(0);
  }

  if (cmd === "rollup") {
    if (!arg) {
      console.error("usage: tlc harness obs rollup <conversation_id>");
      process.exit(1);
    }
    const rollup = coreFacade.observability.getRollup(root, arg);
    if (json) {
      emitJson({ session: arg, rollup });
    } else {
      console.log(JSON.stringify(rollup, null, 2));
    }
    process.exit(0);
  }

  if (cmd === "prune") {
    // why: retention is a project decision now, so prune reads the policy rather than the module default.
    const retentionDays = loadPolicy(root).obs.retentionDays;
    coreFacade.observability.pruneObs(root, retentionDays);
    const spoolDropped = coreFacade.observability.pruneSpool(retentionDays);
    if (json) {
      emitJson({ pruned: true, retentionDays, spoolDropped });
    } else {
      console.log(`pruned old session rollups; dropped ${spoolDropped} spool record(s)`);
    }
    process.exit(0);
  }

  console.error("usage: tlc harness obs <live|events|why|report|rollup|prune> [arg] [--json]");
  process.exit(1);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
