/**
 * Types for a `.mjs` tool with two `.ts` callers: its own suite, and `check-scopes.ts`, which needs
 * `parsePackReport` rather than a second implementation of "find npm's report on a stream that also carries the
 * bundler's output".
 */
export type PackReport = { filename?: string; files?: { path: string }[] };

export type ProbeStep = { label: string; command: string; expect?: string };

export type ProbeResult =
  | { ok: true; room?: string }
  | { ok: false; step: ProbeStep; index: number; output: string; reason: string; room?: string };

export function assertPayload(entries: string[]): string[];
export function probeSteps(tarball: string, version: string): ProbeStep[];
export function parsePackReport(stdout: string): PackReport | null;
export function runSteps(steps: ProbeStep[], options: Record<string, unknown>): ProbeResult;
export function probeEnv(
  base: Record<string, string | undefined>,
  prefix: string,
  home: string,
): Record<string, string | undefined>;
export function manifestSpec(
  argv: string[],
  identity: { name: string; version: string },
): { spec: string; version: string } | null;
export function registrySpec(argv: string[]): { spec: string; version: string } | null;
export function attempts(argv: string[]): number;
