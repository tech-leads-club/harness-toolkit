#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyClaudeWiring } from "../src/providers/claude/claude.wiring.ts";
import { applyCodexWiring } from "../src/providers/codex/codex.wiring.ts";
import { providers } from "../src/providers/index.ts";

const CURSOR_MARKER = "tlc-exec.mjs";

function quoteIfNeeded(token) {
  return token.includes(" ") ? `"${token}"` : token;
}

function commandStringFor(entry) {
  return [entry.command, ...entry.args].map(quoteIfNeeded).join(" ");
}

export function renderCursorHooksDocument(entries) {
  const hooks = {};
  for (const entry of entries) {
    const rendered = { command: commandStringFor(entry), timeout: entry.timeoutSeconds };
    if (entry.failClosed) {
      rendered.failClosed = true;
    }
    if (entry.matcher !== undefined) {
      rendered.matcher = entry.matcher;
    }
    if (entry.loopLimit !== undefined) {
      rendered.loop_limit = entry.loopLimit;
    }
    hooks[entry.hookEvent] = [...(hooks[entry.hookEvent] ?? []), rendered];
  }
  return { version: 1, hooks };
}

export function isCursorWired(targetPath) {
  return existsSync(targetPath) && readFileSync(targetPath, "utf8").includes(CURSOR_MARKER);
}

export function applyCursorWiring(wiring, { force = false } = {}) {
  const targetPath = wiring.target;
  const document = renderCursorHooksDocument(wiring.entries);
  const rendered = `${JSON.stringify(document, null, 2)}\n`;

  if (existsSync(targetPath) && !force) {
    if (isCursorWired(targetPath)) {
      return { status: "unchanged", target: targetPath };
    }
    return {
      status: "refused",
      target: targetPath,
      reason: `${targetPath} exists without harness entries — rerun with --force to overwrite, or merge manually.`,
    };
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, rendered);
  return { status: "written", target: targetPath };
}

export function applyProviderWiring(wiring, { force = false } = {}) {
  if (wiring.strategy === "replace") {
    return applyCursorWiring(wiring, { force });
  }
  const result = wiring.commandFormat === "shell"
    ? applyCodexWiring(wiring.target, wiring.entries)
    : applyClaudeWiring(wiring.target, wiring.entries);
  if (!result.ok) {
    return { status: "failed", target: wiring.target, reason: result.error };
  }
  return { status: result.changed ? "merged" : "unchanged", target: wiring.target };
}

export function isProviderHomePresent(wiring) {
  return existsSync(dirname(wiring.target));
}

function report(result) {
  switch (result.status) {
    case "written":
      console.log(`hooks: wrote ${result.target}`);
      return true;
    case "merged":
      console.log(`hooks: merged ${result.target}`);
      return true;
    case "unchanged":
      console.log(`hooks: unchanged (${result.target})`);
      return true;
    case "refused":
      console.error(`hooks: ${result.reason}`);
      return false;
    case "failed":
      console.error(`hooks: failed to update ${result.target}: ${result.reason}`);
      return false;
    default:
      return false;
  }
}

export function main() {
  const binDir = dirname(fileURLToPath(import.meta.url));
  // hazard: ESM resolves import.meta.url to the realpath, so deriving the launcher from it bakes
  // the checkout location into every hook. TLC_HOME is the install path and survives a move.
  const harnessHome = process.env.TLC_HOME?.trim() || join(binDir, "..");
  const launcherPath = join(harnessHome, "bin", "tlc-exec.mjs");
  const force = process.argv.includes("--force");
  let anyFailed = false;

  for (const provider of providers) {
    const wiring = provider.wiring({ launcherPath });
    if (!isProviderHomePresent(wiring)) {
      console.log(`hooks: ${provider.name} not installed — skipping (${dirname(wiring.target)} not found)`);
      continue;
    }
    if (wiring.commandFormat === "shell") {
      console.log("hooks: review and trust the installed Codex hooks with /hooks before relying on them.");
    }
    if (!report(applyProviderWiring(wiring, { force }))) {
      anyFailed = true;
    }
  }

  process.exitCode = anyFailed ? 1 : 0;
}

if (import.meta.main) {
  main();
}
