import { spawn } from "node:child_process";
import { hostname } from "node:os";

const TIMEOUT_EXIT_CODE = 124;

/** Asks the OS whether a pid exists. Injected so the ESRCH and EPERM branches are testable on every platform. */
export type ProcessProbe = (pid: number) => void;

const defaultProbe: ProcessProbe = (pid) => {
  process.kill(pid, 0);
};

/**
 * Whether the process that recorded `pid`/`host` is still running, right now, on this machine.
 *
 * why: a pid means nothing on another host, so a mismatch answers "alive" rather than guessing.
 * `process.kill(pid, 0)` sends no signal, it only asks whether the process exists; `ESRCH` is the one answer
 * that proves it does not. Extracted from `gate.lock.ts`'s original `isLockOwnerGone`, its only consumer — a
 * pid outlives one long-running gate command's own duration ([/decisions/ad-122.md](/decisions/ad-122.md)).
 */
export function isProcessAlive(
  pid: number,
  host: string,
  thisHost: string = hostname(),
  probe: ProcessProbe = defaultProbe,
): boolean {
  if (host !== thisHost) {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    probe(pid);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runProcess(args: {
  command: string[];
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [file, ...argv] = args.command;
  if (file === undefined) {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(file, argv, {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "pipe"] as const,
      env: args.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      args.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, args.timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ exitCode: TIMEOUT_EXIT_CODE, stdout, stderr: `${stderr}\n(process timed out)` });
        return;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    if (args.input !== undefined) {
      child.stdin.write(args.input);
    }
    child.stdin.end();
  });
}

export type CommandResult = { exitCode: number; output: string; durationMs: number };

export const NO_OUTPUT_CAPTURED = "(no output captured)";

/**
 * why: a gate command's output is read for a human — trimmed of surrounding noise, given a placeholder when
 * there is nothing to show. `runProcess` stays the raw primitive; this is the one caller-facing policy layer
 * on top of it, and the only one — no other function in this codebase shapes output for display
 * ([/decisions/ad-134.md](/decisions/ad-134.md)).
 */
export async function runCommand(
  projectDir: string,
  command: string[],
  extraArgs: string[] = [],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  if (command.length === 0) {
    return { exitCode: 0, output: "", durationMs: 0 };
  }
  const started = Date.now();
  const result = await runProcess({
    command: [...command, ...extraArgs],
    cwd: projectDir,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  const combined = (result.stdout + result.stderr).trim();
  const output = combined.length === 0 ? NO_OUTPUT_CAPTURED : combined;
  return {
    exitCode: result.exitCode,
    output,
    durationMs: Date.now() - started,
  };
}
