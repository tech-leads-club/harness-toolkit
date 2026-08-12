export const GATE_SCHEMA = "harness.gate.v1" as const;

export type GateFinding = {
  id?: string;
  summary: string;
  detail?: string;
};

export type LastGateArtifact = {
  schema: typeof GATE_SCHEMA;
  gate: string;
  exitCode: number;
  passed: boolean;
  command: string[];
  files: string[];
  durationMs: number;
  ts: string;
  outputTail: string;
  findings: GateFinding[];
  /**
   * The content hash of the command and files this verdict was produced under. Absent on an artifact written
   * before the field existed, which is why the first run after an upgrade always executes
   * ([/decisions/ad-045.md](/decisions/ad-045.md)).
   */
  inputsHash?: string;
  /**
   * Project-scoping environment variables that were set when this gate ran, by name.
   *
   * why: recorded always, as a fact rather than an alarm. A gate failing because the hook's environment points
   * its fixtures at the real repository is indistinguishable, from the follow-up alone, from a gate failing
   * because the code is wrong — and it cost four stop loops of editing code that was not broken. Absent on an
   * artifact written before the field existed ([/decisions/ad-060.md](/decisions/ad-060.md)).
   */
  scopedEnv?: string[];
};

export type AppendFilesMode = "auto" | "always" | "never";

export type FailureCategory =
  | "agent-quality"
  | "stagnation"
  | "verification"
  | "ship-evidence"
  | "policy"
  | "config"
  | "budget";

export type GateGap = {
  id: string;
  gate: string;
  category: FailureCategory;
  summary: string;
  detail?: string;
};

export type LockBody = {
  provider: string;
  session: string;
  pid: number;
  acquired_at: string;
  /**
   * The machine that wrote the lock. A pid only means something on the host that issued it, so liveness is
   * consulted only when this matches. A body without it — written by an older build — falls back to the age
   * rule, which is the honest answer when liveness cannot be established.
   */
  host?: string;
};
