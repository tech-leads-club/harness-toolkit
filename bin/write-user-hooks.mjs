#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyClaudeWiring } from "../src/providers/claude/claude.wiring.ts";
import { applyCodexWiring } from "../src/providers/codex/codex.wiring.ts";
import { isOpencodeManaged, renderOpencodePlugin } from "../src/providers/opencode/opencode.wiring.ts";
import { VSCODE_DEFERRAL_REASON } from "../src/providers/vscode/vscode.wiring.ts";
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

/**
 * The bridge opencode loads. Both generations are written the same way — a whole module, replaced wholesale —
 * and differ only in the text `renderOpencodePlugin` produces for the kind.
 *
 * invariant: a file without the managed marker was written by a human, and is refused rather than overwritten.
 * That is the same rule `applyCursorWiring` applies to a hooks file one function above, and it is the reason the
 * marker is a comment the host ignores rather than a field in the module's exports.
 */
export function applyOpencodePluginWiring(wiring, { force = false } = {}) {
  const targetPath = wiring.target;
  const rendered = renderOpencodePlugin(wiring);
  if (rendered === null) {
    return { status: "failed", target: targetPath, reason: `no plugin renderer for kind "${wiring.kind}"` };
  }
  if (existsSync(targetPath) && !force) {
    const existing = readFileSync(targetPath, "utf8");
    if (!isOpencodeManaged(existing)) {
      return {
        status: "refused",
        target: targetPath,
        reason: `${targetPath} exists and was not written by the harness — rerun with --force to overwrite, or move it aside.`,
      };
    }
    if (existing === rendered) {
      return { status: "unchanged", target: targetPath };
    }
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, rendered);
  return { status: "written", target: targetPath };
}

/**
 * why it dispatches on `kind` and not on `strategy`: `strategy` answers replace-or-merge, which is not the same
 * question as which writer to call. A flat hooks JSON and an ES-module plugin are both `replace` and need
 * different writers, so a `strategy` branch would silently hand the second one to the first one's writer.
 *
 * hazard: this file is `.mjs`, so `tsconfig.json` does not typecheck it and an unhandled `kind` cannot be caught
 * here at build time. The compile-time gate lives in `tools/doctor.ts`, whose switch over the same union is
 * exhaustive; this refuses at runtime so an unhandled kind fails loudly instead of writing the wrong format.
 */
export function applyProviderWiring(wiring, { force = false } = {}) {
  switch (wiring.kind) {
    case "cursor-hooks-json":
      return applyCursorWiring(wiring, { force });
    case "opencode-plugin":
    case "opencode-plugin-ns":
      return applyOpencodePluginWiring(wiring, { force });
    case "claude-settings-json": {
      const result = applyClaudeWiring(wiring.target, wiring.entries);
      if (!result.ok) {
        return { status: "failed", target: wiring.target, reason: result.error };
      }
      return { status: result.changed ? "merged" : "unchanged", target: wiring.target };
    }
    // why merge and not replace: `hooks.json` is a shared file. A group that does not name our launcher belongs to
    // someone else's tooling, and survives byte-identical.
    case "codex-hooks-json": {
      const result = applyCodexWiring(wiring.target, wiring.entries);
      if (!result.ok) {
        return { status: "failed", target: wiring.target, reason: result.error };
      }
      return { status: result.changed ? "merged" : "unchanged", target: wiring.target };
    }
    /**
     * The deferral branch, not a missing writer. `vscode.wiring.ts` renders the document and is unit-tested
     * against a golden file; what is withheld is the dispatch, while Agent Hooks are Preview and the hook file
     * schema is unpublished ([/decisions/ad-126.md](/decisions/ad-126.md), spec P4 AC5).
     *
     * why a status of its own rather than `refused`: a refusal means the operator has something to fix. This one
     * is the harness's own decision and nothing on the machine changes it, so it reports as skipped and does not
     * fail the install.
     */
    case "vscode-hooks-json":
      return { status: "deferred", target: wiring.target, reason: VSCODE_DEFERRAL_REASON };
    default:
      return {
        status: "failed",
        target: wiring.target,
        reason: `no writer for wiring kind "${wiring.kind}"`,
      };
  }
}

/**
 * Whether the host this wiring belongs to is installed at all.
 *
 * hazard: the answer is the target's parent directory only where that parent is the host's own config directory.
 * Every directory below `~/.config/opencode` is created by whoever adds the first plugin — a clean opencode
 * install has no `plugins/` at all — so asking about any of them answers "host not installed" on a machine where
 * opencode is running, and the bridge is never written ([/decisions/ad-124.md](/decisions/ad-124.md)). Both
 * opencode kinds therefore ask about the config directory, which is one level above `plugins/`. The VS Code hooks
 * directory is the same shape: `~/.copilot` says the host is there, `~/.copilot/hooks` says somebody already
 * wrote a hook file.
 */
export function providerHomeDir(wiring) {
  switch (wiring.kind) {
    // why two levels: both opencode kinds share `<config>/plugins/tlc-harness.js`, and the VS Code hook file is
    // `~/.copilot/hooks/tlc-harness.json`.
    case "opencode-plugin":
    case "opencode-plugin-ns":
    case "vscode-hooks-json":
      return dirname(dirname(wiring.target));
    default:
      return dirname(wiring.target);
  }
}

export function isProviderHomePresent(wiring) {
  return existsSync(providerHomeDir(wiring));
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
    case "deferred":
      console.log(`hooks: skipped ${result.target} — ${result.reason}`);
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
      console.log(`hooks: ${provider.name} not installed — skipping (${providerHomeDir(wiring)} not found)`);
      continue;
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
