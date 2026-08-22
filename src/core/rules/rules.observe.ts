/**
 * What an event proves, if anything.
 *
 * invariant: pure. The caller supplies the sha and the clock; this decides whether the event is worth recording
 * and as what.
 *
 * why `tool.after` and not an exit code: measured on 3,755 real `shell.after` records from this machine, the
 * payload carries `tool_response: {stdout, stderr, interrupted, …}` and **no exit code**, in any of the three
 * shapes the two hosts send. But a tool that fails arrives as `tool.failure` — a different event, 64 of them in
 * the same file, one of which is a `Bash` that exited non-zero. So observing at `tool.after` already means the
 * command ran and did not fail, and no exit code is needed to say it
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 *
 * hazard: 65 of those `shell.after` records carry a non-empty stderr. Treating stderr as failure would discard
 * proof from every command that warns.
 */
import type { Observation } from "./rules.proof.ts";

export type ObservableEvent = {
  event: string;
  toolName?: string;
  command?: string;
  filePath?: string;
  /**
   * hazard: this was `subagentType`, which is the field a *spawn* carries. On `subagent.stop` both hosts put the
   * type in `spawnSubagentType` — measured by running a real payload of each shape through the providers. So the
   * producer read `undefined` and recorded nothing, and the unit test passed because its fixture invented the
   * field name it was asserting about ([/decisions/ad-100.md](/decisions/ad-100.md)).
   */
  spawnSubagentType?: string;
  /**
   * What the host calls this spawn, which is not what the spawn declared.
   *
   * hazard: the documented `agent_type` field of `SubagentStart`/`SubagentStop` is described as the agent's name,
   * and when a spawn is given a `name` the host puts that name here — so a value the gated agent chose was being
   * recorded as the type it must prove. That made a legitimate review fail to satisfy the rule *and* made the
   * proof forgeable: a `general-purpose` subagent named `the-judge` would have satisfied it
   * ([/decisions/ad-104.md](/decisions/ad-104.md)).
   */
  spawnAgentLabel?: string;
};

export type ObserveContext = { sha: string | null; sessionKey: string; at: string };

/** What the event says happened, with no `when` attached to it yet. */
export type ObservedFact = { kind: Observation["kind"]; value: string };

/**
 * invariant: one event, at most one observation. A `tool.after` that carries both a command and a path is a
 * command — the path is its argument, not a file the turn wrote.
 *
 * why this is separate from `observationFrom`: the sha is a process spawn and this answers whether anything is
 * worth spawning for. One place still decides what an event means
 * ([/decisions/ad-100.md](/decisions/ad-100.md)).
 */
export function observedFact(event: ObservableEvent): ObservedFact | null {
  if (event.event === "subagent.stop") {
    // why the type and not the id: a rule says "the jury reviewed", not "agent 7f3a reviewed".
    //
    // why the label is a fallback and not the first choice: it is what the host calls the spawn, which the gated
    // agent chooses when it names one. A host that sends the declared type wins; a host that sends only a label
    // degrades to it, which is visible rather than silent ([/decisions/ad-104.md](/decisions/ad-104.md)).
    const value = event.spawnSubagentType ?? event.spawnAgentLabel;
    return value === undefined ? null : { kind: "subagent", value };
  }

  if (event.event === "tool.after" || event.event === "shell.after") {
    return event.command === undefined ? null : { kind: "command", value: event.command };
  }

  if (event.event === "edit.after") {
    return event.filePath === undefined ? null : { kind: "file", value: event.filePath };
  }

  return null;
}

export function observationFrom(event: ObservableEvent, context: ObserveContext): Observation | null {
  const fact = observedFact(event);
  return fact === null ? null : { ...fact, sha: context.sha, sessionKey: context.sessionKey, at: context.at };
}

/**
 * A gate outcome is not an event the host sends — the harness decides it. So it is recorded where it is decided,
 * with the gate's own name.
 */
export function gateObservation(gate: string, context: ObserveContext): Observation {
  return { kind: "gate", value: gate, sha: context.sha, sessionKey: context.sessionKey, at: context.at };
}

/**
 * The elo a spawn leaves behind: the type it declared, under the label the host will echo back at the stop.
 *
 * why `tool.after` and not `tool.before`: after means the host accepted the spawn. A spawn refused by the
 * allowlist rail must not leave a link that a later stop could resolve against
 * ([/decisions/ad-104.md](/decisions/ad-104.md)).
 *
 * invariant: only a spawn that declared a type and carries a label is worth linking. Without a label there is
 * nothing to resolve at the stop, and without a declared type there is nothing to resolve *to*.
 */
export function spawnLinkFrom(event: ObservableEvent): { label: string; type: string } | null {
  if (event.event !== "tool.after" || !SPAWN_TOOLS.has(event.toolName ?? "")) {
    return null;
  }
  const { spawnAgentLabel: label, spawnSubagentType: type } = event;
  return label === undefined || type === undefined || label === type ? null : { label, type };
}

const SPAWN_TOOLS = new Set(["Task", "Agent"]);

/**
 * The stop, with the label resolved back to the type the spawn declared.
 *
 * invariant: the newest link wins, because a label can be reused across a session and the proof is about now.
 * A stop that already carries a declared type is returned untouched — a host that answers correctly is never
 * second-guessed ([/decisions/ad-104.md](/decisions/ad-104.md)).
 */
export function resolveSpawnType(
  event: ObservableEvent,
  links: () => readonly { label: string; type: string }[],
): ObservableEvent {
  if (event.event !== "subagent.stop" || event.spawnSubagentType !== undefined) {
    return event;
  }
  const label = event.spawnAgentLabel;
  if (label === undefined) {
    return event;
  }
  const matches = links().filter((link) => link.label === label);
  const newest = matches[matches.length - 1];
  return newest === undefined ? event : { ...event, spawnSubagentType: newest.type };
}
