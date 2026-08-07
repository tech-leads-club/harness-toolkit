// src/entrypoints/shim.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join as join2 } from "node:path";

// src/platform/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function conventionalRuntimeHome() {
  return join(homedir(), ".tlc", "harness");
}
function runtimeHome(env = process.env) {
  return env.TLC_HOME ?? conventionalRuntimeHome();
}

// src/entrypoints/shim.ts
var handler = process.argv[2];
if (!handler) {
  console.error("usage: shim <handler-name>");
  process.exit(1);
}
if (process.env.TLC_ACTIVE === "1") {
  process.stdout.write(`{}
`);
  process.exit(0);
}
var home = runtimeHome();
var execBin = join2(home, "bin", "tlc-exec");
var distHandler = join2(home, "dist", `${handler}.mjs`);
var srcHandler = join2(home, "src", "entrypoints", `${handler}.ts`);
function run(command, args) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  process.stdin.pipe(child.stdin);
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.on("close", (code) => {
    process.stdout.write(stdout);
    process.exit(code ?? 0);
  });
}
if (existsSync(execBin)) {
  run(execBin, [handler]);
} else if (existsSync(distHandler)) {
  run(process.execPath, [distHandler]);
} else if (existsSync(srcHandler)) {
  run(process.env.BUN_BIN || "bun", ["run", srcHandler]);
} else {
  console.error(`tlc shim: handler not found: ${handler}`);
  process.exit(127);
}
