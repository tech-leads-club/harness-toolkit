export const MIN_NODE_MAJOR: number;

export function conventionalHarnessHome(home?: string): string;

export function isPackagedCopy(candidate: string): boolean;

export type HarnessHomeDeps = {
  realpath: (path: string) => string;
  home: () => string;
  exists?: (path: string) => boolean;
};

export function resolveHarnessHome(
  binDir: string,
  env?: Record<string, string | undefined>,
  invoked?: string,
  deps?: HarnessHomeDeps,
): string;

export function bunExecutableName(platform?: string): string;

export function findBunOnPath(
  env?: Record<string, string | undefined>,
  platform?: string,
): string | null;

export function runtimeCachePath(harnessHome: string): string;

export type RuntimeCache = { bunPath: string | null; checkedAt: string };

export function readRuntimeCache(harnessHome: string): RuntimeCache | null;

export function writeRuntimeCache(harnessHome: string, bunPath: string | null): RuntimeCache;

export function resolveBunPath(
  harnessHome: string,
  env?: Record<string, string | undefined>,
  platform?: string,
): string | null;

export function entrySourceCandidates(harnessHome: string, entry: string): string[];

export function resolveEntrySource(harnessHome: string, entry: string): string | null;

export type RuntimeDecisionInput = {
  harnessHome: string;
  entry: string;
  bunPath: string | null;
  nodeMajor: number;
  distExists: boolean;
  srcPath: string | null;
};

export type RuntimeDecision =
  | { kind: "run"; command: string; args: string[] }
  | { kind: "error"; status: number; message: string };

export function decideRuntime(input: RuntimeDecisionInput): RuntimeDecision;

export function main(argv?: string[]): void;
