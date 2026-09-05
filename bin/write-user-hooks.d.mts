import type { ProviderWiring, WiringEntry } from "../src/contracts/index.ts";

export type CursorHookDef = {
  command: string;
  timeout: number;
  failClosed?: true;
  matcher?: string;
  loop_limit?: number;
};

export type CursorHooksDocument = {
  version: 1;
  hooks: Record<string, CursorHookDef[]>;
};

export function renderCursorHooksDocument(entries: readonly WiringEntry[]): CursorHooksDocument;

export function isCursorWired(targetPath: string): boolean;

export type ApplyOptions = { force?: boolean };

export type CursorApplyResult =
  | { status: "written"; target: string }
  | { status: "unchanged"; target: string }
  | { status: "refused"; target: string; reason: string };

export function applyCursorWiring(wiring: ProviderWiring, options?: ApplyOptions): CursorApplyResult;

export type ClaudeApplyResult =
  | { status: "merged"; target: string }
  | { status: "unchanged"; target: string }
  | { status: "failed"; target: string; reason: string };

/**
 * The wiring kind whose writer exists and is deliberately not called: nothing on the machine changes it, so it
 * is neither a refusal nor a failure ([/decisions/ad-126.md](/decisions/ad-126.md)).
 */
export type DeferredApplyResult = { status: "deferred"; target: string; reason: string };

export type ApplyResult = CursorApplyResult | ClaudeApplyResult | DeferredApplyResult;

export function applyOpencodePluginWiring(
  wiring: ProviderWiring,
  options?: ApplyOptions,
): CursorApplyResult | { status: "failed"; target: string; reason: string };

export function applyProviderWiring(wiring: ProviderWiring, options?: ApplyOptions): ApplyResult;

export function providerHomeDir(wiring: ProviderWiring): string;

export function isProviderHomePresent(wiring: ProviderWiring): boolean;

export function main(): void;
