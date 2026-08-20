import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coreFacade, type ProviderSettings } from "../core/index.ts";
import { runtimeHome, userSettingsPaths } from "../platform/paths.ts";

function requireHandler(): string {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: shim <handler-name>");
    process.exit(1);
  }
  return name;
}

const handler = requireHandler();

/**
 * hazard: a project-level hook and a user-level hook both fire for the same event, and the host merges the two
 * rather than replacing one with the other. This used to read `TLC_ACTIVE`, which nothing ever set — a hook cannot
 * export an environment variable to a later hook process, so the condition was never true and both levels ran the
 * handler every time ([/decisions/ad-095.md](/decisions/ad-095.md)).
 *
 * invariant: read from disk, because two hooks in one event share no channel except the filesystem.
 */
// why: the first document that covers the handler wins, and a document that does not cover it must not stop the
// next one being read — otherwise a user with only one editor installed globally would decide for both.
function coveringSettings(): ProviderSettings | null {
  let seen: ProviderSettings | null = null;
  for (const path of userSettingsPaths()) {
    let parsed: ProviderSettings;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as ProviderSettings;
    } catch {
      continue;
    }
    seen = parsed;
    if (coreFacade.shim.coversHandler(parsed, handler)) {
      return parsed;
    }
  }
  return seen;
}

const decision = coreFacade.shim.decideShim(coveringSettings(), handler);
if (!decision.run) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const home = runtimeHome();
/**
 * hazard: this was the extensionless bash wrapper, which Windows cannot execute — so the first branch simply
 * never fired there and the shim fell through to the bundle. The launcher is a `.mjs` run by the interpreter
 * already running this, which behaves the same on every platform
 * ([/decisions/ad-097.md](/decisions/ad-097.md)).
 */
const execBin = join(home, "bin", "tlc-exec.mjs");
const distHandler = join(home, "dist", `${handler}.mjs`);
const srcHandler = join(home, "src", "entrypoints", `${handler}.ts`);

function run(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  process.stdin.pipe(child.stdin);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.on("close", (code) => {
    process.stdout.write(stdout);
    process.exit(code ?? 0);
  });
}

if (existsSync(execBin)) {
  run(process.execPath, [execBin, handler]);
} else if (existsSync(distHandler)) {
  run(process.execPath, [distHandler]);
} else if (existsSync(srcHandler)) {
  run(process.env.BUN_BIN || "bun", ["run", srcHandler]);
} else {
  console.error(`tlc shim: handler not found: ${handler}`);
  process.exit(127);
}
