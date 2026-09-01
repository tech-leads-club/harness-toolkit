import assert from "node:assert/strict";
import { hostname } from "node:os";
import { describe, test } from "node:test";
import { isProcessAlive, runProcess } from "../process.ts";

describe("runProcess", () => {
  test("resolves with exit code 0 and captures stdout for a successful command", async () => {
    const result = await runProcess({ command: ["node", "-e", "console.log('hello')"] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "hello");
  });

  test("captures stderr output", async () => {
    const result = await runProcess({ command: ["node", "-e", "console.error('boom')"] });
    assert.equal(result.stderr.trim(), "boom");
  });

  test("returns exit code 0 immediately for an empty command array", async () => {
    const result = await runProcess({ command: [] });
    assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
  });

  test("does not time out when the command finishes before timeoutMs elapses", async () => {
    const result = await runProcess({
      command: ["node", "-e", "console.log('fast')"],
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "fast");
  });

  test("enforces timeoutMs and resolves with a non-zero exit code instead of hanging", async () => {
    const result = await runProcess({
      command: ["node", "-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 150,
    });
    assert.notEqual(result.exitCode, 0);
  });

  test("behaves identically to before when timeoutMs is omitted (no enforcement)", async () => {
    const result = await runProcess({
      command: ["node", "-e", "setTimeout(() => { console.log('done'); }, 200)"],
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "done");
  });
});

function throwing(code: string): (pid: number) => void {
  return () => {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    throw error;
  };
}

/**
 * AD-122 — extracted from `gate.lock.ts`'s own liveness check, which already covered every branch below with
 * an injected probe rather than a real pid, for the same cross-platform reason: no pid is guaranteed to exist
 * or not exist identically on linux, macos and windows.
 */
describe("isProcessAlive", () => {
  test("a different host is never provable dead", () => {
    assert.equal(isProcessAlive(123, "other-host", "this-host"), true);
  });

  test("a pid that cannot name a process is never consulted", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      assert.equal(isProcessAlive(pid, hostname()), true, String(pid));
    }
  });

  test("a process that exists but is not ours (EPERM) counts as alive", () => {
    assert.equal(isProcessAlive(123, hostname(), hostname(), throwing("EPERM")), true);
  });

  test("only ESRCH means the process is gone", () => {
    assert.equal(isProcessAlive(123, hostname(), hostname(), throwing("ESRCH")), false);
    for (const code of ["EINVAL", "EACCES", "UNKNOWN", ""]) {
      assert.equal(isProcessAlive(123, hostname(), hostname(), throwing(code)), true, code);
    }
  });

  test("a probe that returns without throwing means the process is alive", () => {
    assert.equal(
      isProcessAlive(123, hostname(), hostname(), () => undefined),
      true,
    );
  });

  test("the default probe finds this very test process alive", () => {
    assert.equal(isProcessAlive(process.pid, hostname()), true);
  });
});
