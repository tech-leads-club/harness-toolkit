import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { NPM_MARKER, NPM_PACKAGE } from "../bin/tlc-cli.ts";
import { claudeConfigDir, cursorConfigDir, runtimeHome } from "../src/platform/paths.ts";
import { type Row, render, type Screen } from "../src/platform/screen.ts";
import { createStyle, PLAIN, type Style } from "../src/platform/style.ts";
import { removeClaudeWiring, unmergeClaudeSettings } from "../src/providers/claude/claude.wiring.ts";
import { unwireCursorHooks } from "../src/providers/cursor/cursor.wiring.ts";
import { OPERATOR_OWNED, RUNTIME_PAYLOAD } from "./install-runtime.ts";

/**
 * `unmerge` rewrites a file the operator owns, keeping everything that is not ours. `unlink` removes a symlink
 * without reading through it. `remove` deletes a path the installer created. `keep` is an artefact examined and
 * deliberately left. `manual` is work this command will not do, printed so it is not silently skipped.
 */
export type ItemAction = "unmerge" | "unlink" | "remove" | "keep" | "manual";

export type PlanItem = { action: ItemAction; target: string; detail: string };

export type UninstallPlan = {
  items: PlanItem[];
  purge: boolean;
  /** hazard: a symlinked home points at somebody's working clone. Nothing inside it may be removed. */
  homeIsLink: boolean;
};

export type UninstallTargets = {
  home: string;
  binLink: string;
  claudeSettings: string;
  cursorHooks: string;
  skillLinks: string[];
};

export function uninstallTargets(env: NodeJS.ProcessEnv = process.env): UninstallTargets {
  const home = runtimeHome(env);
  const binDir = env.TLC_BIN_DIR?.trim() || join(env.HOME ?? "", ".local", "bin");
  return {
    home,
    binLink: join(binDir, "tlc"),
    claudeSettings: join(claudeConfigDir(), "settings.json"),
    cursorHooks: join(cursorConfigDir(), "hooks.json"),
    skillLinks: [
      join(claudeConfigDir(), "skills", "harness-init"),
      join(cursorConfigDir(), "skills", "harness-init"),
    ],
  };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * hazard: `realpathSync` throws on a dangling link, and a link into a runtime home that was already deleted is
 * exactly the state a second uninstall run finds. Falling back to resolving the link text keeps such a link
 * recognisable as ours instead of stranding it forever.
 */
function resolveLink(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      const target = readlinkSync(path);
      return isAbsolute(target) ? target : resolve(dirname(path), target);
    } catch {
      return path;
    }
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// invariant: a link is ours only when it lands inside the runtime home. A `tlc` on PATH belonging to something
// else keeps its name, and this command is not the place to argue about it.
function pointsInto(link: string, home: string): boolean {
  const target = resolveLink(link);
  const root = canonical(home);
  return target === root || target.startsWith(`${root}/`);
}

/**
 * `target` — the link is ours only when it lands inside the runtime home. `location` — the path itself is the
 * installer's artefact and the target is irrelevant.
 *
 * hazard: both rules were `target` at first, and running the command on the machine it was written on found a
 * `~/.claude/skills/harness-init` pointing at a `/tmp` install deleted weeks earlier. Under the target rule that
 * dangling link is "not ours" and survives every uninstall forever. `tlc` on PATH is a name anybody may own, so
 * it keeps the target rule; `skills/harness-init` is a path only this installer writes
 * ([/decisions/ad-066.md](/decisions/ad-066.md)).
 */
type LinkOwnership = "target" | "location";

function planLink(
  items: PlanItem[],
  path: string,
  home: string,
  label: string,
  ownership: LinkOwnership,
): void {
  if (!existsSync(path) && !isSymlink(path)) {
    return;
  }
  if (!isSymlink(path)) {
    items.push({
      action: "keep",
      target: path,
      detail: `${label} is a real file, not a link the installer made`,
    });
    return;
  }
  if (ownership === "target" && !pointsInto(path, home)) {
    items.push({ action: "keep", target: path, detail: `points at ${resolveLink(path)} — not ours` });
    return;
  }
  const stale = ownership === "location" && !pointsInto(path, home);
  items.push({
    action: "unlink",
    target: path,
    detail: stale ? `${label}, stale — points at ${resolveLink(path)}` : label,
  });
}

function planClaude(items: PlanItem[], settingsPath: string): void {
  if (!existsSync(settingsPath)) {
    return;
  }
  const result = unmergeClaudeSettings(readFileSync(settingsPath, "utf8"));
  if (!result.ok) {
    items.push({
      action: "keep",
      target: settingsPath,
      detail: `left untouched — it does not parse as JSON: ${result.error}`,
    });
    return;
  }
  if (!result.changed) {
    return;
  }
  items.push({
    action: "unmerge",
    target: settingsPath,
    detail: "drop the harness hook groups, keep every other key and every foreign hook",
  });
}

function planCursor(items: PlanItem[], hooksPath: string): void {
  const text = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : null;
  const result = unwireCursorHooks(text);
  switch (result.kind) {
    case "absent":
      return;
    case "unparsed":
      items.push({ action: "keep", target: hooksPath, detail: "left untouched — it does not parse as JSON" });
      return;
    case "empty":
      if (result.removed > 0) {
        items.push({ action: "remove", target: hooksPath, detail: `${result.removed} entries, all ours` });
      }
      return;
    default:
      items.push({
        action: "unmerge",
        target: hooksPath,
        detail: `drop ${result.removed} harness entries, keep the rest`,
      });
  }
}

function planRuntime(items: PlanItem[], home: string, purge: boolean): boolean {
  const homeIsLink = isSymlink(home);
  if (homeIsLink) {
    // hazard: this is the contributor's checkout on every development machine. `rm -rf` through the link deletes
    // the repository. The installer refuses to touch it for the same reason (AD-046) and so does this.
    items.push({
      action: "unlink",
      target: home,
      detail: `a link to ${resolveLink(home)} — the checkout it points at is left exactly as it is`,
    });
    return true;
  }
  if (!existsSync(home)) {
    return false;
  }
  for (const entry of RUNTIME_PAYLOAD) {
    const path = join(home, entry);
    if (existsSync(path)) {
      items.push({ action: "remove", target: path, detail: "runtime payload" });
    }
  }
  const marker = join(home, NPM_MARKER);
  if (existsSync(marker)) {
    items.push({ action: "remove", target: marker, detail: "install marker" });
  }
  for (const entry of OPERATOR_OWNED) {
    const path = join(home, entry);
    if (!existsSync(path)) {
      continue;
    }
    items.push(
      purge
        ? { action: "remove", target: path, detail: "--purge" }
        : { action: "keep", target: path, detail: "yours — add --purge to remove it" },
    );
  }
  return false;
}

function planManual(items: PlanItem[], home: string): void {
  if (existsSync(join(home, NPM_MARKER))) {
    items.push({
      action: "manual",
      target: `npm uninstall -g ${NPM_PACKAGE}`,
      // why: a global prefix owned by root needs sudo, and an npm call failing halfway through a teardown leaves
      // a worse state than one that never started ([/decisions/ad-066.md](/decisions/ad-066.md)).
      detail: "the global package is reported, never removed for you",
    });
  }
  items.push({
    action: "manual",
    target: "rm -rf .tlc/ in each repository",
    detail: "per-project config and state — this command does not search your disk for them",
  });
}

export function planUninstall(targets: UninstallTargets, options: { purge?: boolean } = {}): UninstallPlan {
  const purge = options.purge === true;
  const items: PlanItem[] = [];

  planClaude(items, targets.claudeSettings);
  planCursor(items, targets.cursorHooks);
  for (const link of targets.skillLinks) {
    planLink(items, link, targets.home, "skill link", "location");
  }
  planLink(items, targets.binLink, targets.home, "the tlc launcher on PATH", "target");
  const homeIsLink = planRuntime(items, targets.home, purge);
  planManual(items, targets.home);

  return { items, purge, homeIsLink };
}

/** Everything the plan would change. `keep` and `manual` are reported, not counted. */
export function pendingItems(plan: UninstallPlan): PlanItem[] {
  return plan.items.filter(
    (item) => item.action === "unmerge" || item.action === "unlink" || item.action === "remove",
  );
}

export type UninstallResult = { applied: PlanItem[]; failed: { item: PlanItem; reason: string }[] };

export function applyUninstall(plan: UninstallPlan, targets: UninstallTargets): UninstallResult {
  const applied: PlanItem[] = [];
  const failed: { item: PlanItem; reason: string }[] = [];

  for (const item of pendingItems(plan)) {
    try {
      if (item.action === "unmerge" && item.target === targets.claudeSettings) {
        removeClaudeWiring(item.target);
      } else if (item.action === "unmerge") {
        const result = unwireCursorHooks(readFileSync(item.target, "utf8"));
        if (result.kind === "rewritten") {
          writeFileSync(item.target, result.text, "utf8");
        }
      } else if (item.action === "unlink") {
        // why: `unlinkSync` states the intent — remove the link, never what it points at. Measured: `rmSync`
        // with `recursive` happens to agree, unlinking a symlink rather than descending it. The guard that
        // actually prevents the data loss is `planRuntime` returning before any payload path is planned, since
        // `home/src` under a linked home resolves inside the checkout.
        unlinkSync(item.target);
      } else {
        rmSync(item.target, { recursive: true, force: true });
      }
      applied.push(item);
    } catch (error) {
      failed.push({ item, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { applied, failed };
}

const ACTION_LEVEL = {
  unmerge: "warn",
  unlink: "warn",
  remove: "warn",
  keep: "ok",
  manual: "info",
} as const;

export function uninstallScreen(plan: UninstallPlan, result: UninstallResult | null): Screen {
  const pending = pendingItems(plan);
  const applied = result !== null;

  if (pending.length === 0) {
    return {
      title: "harness uninstall",
      summary: ["nothing wired"],
      sections: [
        {
          rows: [{ label: "state", value: "no harness artefact found — nothing to undo", level: "ok" }],
        },
        { title: "STILL YOURS TO DO", rows: manualRows(plan) },
      ],
      footer: "already clean · re-run install with the one-liner in the README",
    };
  }

  const changes: Row[] = pending.map((item) => ({
    label: item.action,
    value: `${item.target} — ${item.detail}`,
    level: ACTION_LEVEL[item.action],
  }));
  const kept = plan.items.filter((item) => item.action === "keep");

  const sections = [
    { title: applied ? "REMOVED" : "WOULD REMOVE", rows: changes },
    ...(kept.length > 0
      ? [
          {
            title: "KEPT",
            rows: kept.map((item) => ({
              label: "keep",
              value: `${item.target} — ${item.detail}`,
              level: "ok" as const,
            })),
          },
        ]
      : []),
    { title: "STILL YOURS TO DO", rows: manualRows(plan) },
    ...(result !== null && result.failed.length > 0
      ? [
          {
            title: "FAILED",
            rows: result.failed.map((entry) => ({
              label: "error",
              value: `${entry.item.target} — ${entry.reason}`,
              level: "fail" as const,
            })),
          },
        ]
      : []),
  ];

  return {
    title: "harness uninstall",
    summary: [
      applied ? `${result.applied.length} applied` : `${pending.length} pending`,
      plan.purge ? "purge: state included" : "purge: state kept",
      plan.homeIsLink ? "runtime: linked checkout, unlinked only" : "runtime: owned by the installer",
    ],
    sections,
    footer: applied
      ? "reinstall any time with the one-liner in the README"
      : "nothing was changed · re-run with --yes to apply this plan",
  };
}

function manualRows(plan: UninstallPlan): Row[] {
  return plan.items
    .filter((item) => item.action === "manual")
    .map((item) => ({ label: "run", value: `${item.target} — ${item.detail}`, level: "info" as const }));
}

export function uninstallReportText(
  plan: UninstallPlan,
  result: UninstallResult | null,
  style: Style = PLAIN,
): string {
  return render(uninstallScreen(plan, result), style);
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const targets = uninstallTargets();
  const plan = planUninstall(targets, { purge: argv.includes("--purge") });
  // why: the plan is the confirmation. A prompt needs a TTY, and the operator reaching for this is as likely to
  // be in CI or a shell that is already half-broken ([/decisions/ad-066.md](/decisions/ad-066.md)).
  const result = argv.includes("--yes") ? applyUninstall(plan, targets) : null;
  console.log(uninstallReportText(plan, result, createStyle()));
  return result !== null && result.failed.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
