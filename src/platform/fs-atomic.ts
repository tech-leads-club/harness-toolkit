import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { nextDelay, retry } from "./backoff.ts";

const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isRetryableFsError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && RETRYABLE_CODES.has(code);
}

function tempPathFor(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

export type FsAtomicOptions = {
  attempts?: number;
  baseMs?: number;
  capMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rename?: (from: string, to: string) => void;
  writeFile?: (path: string, data: string) => void;
  removeFile?: (path: string) => void;
};

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: FsAtomicOptions = {},
): Promise<void> {
  const {
    attempts = 5,
    baseMs = 20,
    capMs = 500,
    random,
    sleep,
    rename = renameSync,
    writeFile = (p: string, data: string) => writeFileSync(p, data, "utf8"),
    removeFile = (p: string) => {
      try {
        rmSync(p, { force: true });
      } catch {}
    },
  } = options;

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = tempPathFor(path);
  writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);

  try {
    await retry(
      () => {
        rename(tempPath, path);
      },
      { attempts, baseMs, capMs, random, sleep, shouldRetry: isRetryableFsError },
    );
  } catch (error) {
    removeFile(tempPath);
    throw error;
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

/**
 * hazard: `EEXIST` is what a held lock looks like on POSIX and only sometimes on Windows. There, a concurrent
 * `wx` open against a file another process is creating or unlinking answers `EPERM` — so the loop below threw
 * instead of waiting, and the two-concurrent-writers test failed in Windows CI with
 * `EPERM: operation not permitted, open '…\handoff.json.lock'`. This module already listed the codes that mean
 * "busy, come back" for its rename; the lock, which is the one place contention is the expected case, did not
 * consult them ([/decisions/ad-086.md](/decisions/ad-086.md)).
 */
function isContention(error: unknown): boolean {
  return errorCode(error) === "EEXIST" || isRetryableFsError(error);
}

/**
 * invariant: prefixed names. `FsAtomicOptions` already carries `attempts` and `sleep` for the rename retry, and
 * `UpdateJsonAtomicOptions` is the intersection of both — sharing a name there would silently hand the lock's
 * budget to the rename, or the other way round.
 */
export type FileLockOptions = {
  /** Injected so the contention branch has a test that does not need a second process or Windows. */
  openLock?: (path: string) => void;
  lockSleep?: (ms: number) => Promise<void>;
  lockAttempts?: number;
};

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const {
    openLock = (path: string) => closeSync(openSync(path, "wx")),
    lockSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    lockAttempts = 200,
  } = options;
  mkdirSync(dirname(lockPath), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < lockAttempts; attempt++) {
    try {
      openLock(lockPath);
      acquired = true;
      break;
    } catch (error) {
      if (!isContention(error)) {
        throw error;
      }
      await lockSleep(nextDelay({ attempt, baseMs: 10, capMs: 200 }));
    }
  }
  if (!acquired) {
    throw new Error(`fs-atomic: could not acquire lock at ${lockPath}`);
  }
  try {
    return await fn();
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {}
  }
}

export type UpdateJsonAtomicOptions = FsAtomicOptions &
  FileLockOptions & {
    lockPath: string;
    /**
     * Run inside the write lock, after the file lands. The platform does not care what it does — recording a
     * content hash is core's business, and doing it here is what makes the record and the content one write.
     */
    afterWrite?: (path: string) => void;
  };

export async function updateJsonAtomic<T>(
  path: string,
  mutator: (current: T | null) => T,
  options: UpdateJsonAtomicOptions,
): Promise<T> {
  const { lockPath, afterWrite, openLock, lockSleep, lockAttempts, ...atomicOptions } = options;
  return withFileLock(
    lockPath,
    async () => {
      const current = readJson<T>(path);
      const next = mutator(current);
      await writeJsonAtomic(path, next, atomicOptions);
      // why: inside the lock. A caller that sealed after the lock released would race the next writer, and the
      // pair that lost would leave a record matching neither content ([/decisions/ad-078.md](/decisions/ad-078.md)).
      afterWrite?.(path);
      return next;
    },
    { openLock, lockSleep, lockAttempts },
  );
}
