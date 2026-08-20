import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { NPM_MARKER, NPM_PACKAGE } from "../bin/tlc-cli.ts";
import { linkDir } from "../src/platform/links.ts";
import { conventionalRuntimeHome, runtimeHome, runtimeHomeWasChosen } from "../src/platform/paths.ts";
import { type Row, render, type Screen } from "../src/platform/screen.ts";
import { createStyle, PLAIN, type Style } from "../src/platform/style.ts";

/**
 * why: an npm-installed copy lives under a directory npm replaces wholesale, so the runtime cannot keep its state
 * there — measured on the packed tarball, which wrote `runtime-cache.json` inside the package on its first run.
 * The package is the delivery vehicle; the runtime that hooks name stays at the conventional home, and this is
 * what puts the code there ([/decisions/ad-056.md](/decisions/ad-056.md)).
 *
 * invariant: an entry here is replaced wholesale, so a file deleted upstream does not survive the update. Nothing
 * outside this list is touched, which is what keeps `config.json`, `state/` and `flags/` the operator's.
 */
export const RUNTIME_PAYLOAD = [
  "bin",
  "capabilities",
  "dist",
  "docs",
  "skills",
  "src",
  "tools",
  "config.example.json",
  "package.json",
] as const;

/** Never copied and never removed. The reason the split exists. */
export const OPERATOR_OWNED = ["config.json", "state", "flags"] as const;

/**
 * Inside a payload entry and still not shipped.
 *
 * why: `tools/dev` holds the checks that validate *this* repository — its module boundaries, its screen contract,
 * its decision records. A user's install has none of that to validate, and with Bun present the launcher resolves
 * an entry straight from source, so copying them would put runnable repo-only commands on their machine. The
 * clone route is different on purpose: a checkout is the repository, and a contributor needs them
 * ([/decisions/ad-068.md](/decisions/ad-068.md)).
 */
export const NOT_SHIPPED = [join("tools", "dev"), join("tools", "__test__")] as const;

export function isShipped(relativePath: string): boolean {
  const normalised = relativePath.split(sep).join("/");
  return !NOT_SHIPPED.some((excluded) => {
    const prefix = excluded.split(sep).join("/");
    return normalised === prefix || normalised.startsWith(`${prefix}/`);
  });
}

export type InstallReport = {
  kind: "copied" | "in-place" | "linked" | "relinked" | "refused";
  source: string;
  dest: string;
  entries: string[];
  missing: string[];
  reason?: string;
};

/** The physical location of the copy that launched us, which is not the home once an npm shim is driving one. */
export function originRoot(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.TLC_ORIGIN?.trim();
  if (declared && declared.length > 0) {
    return resolve(declared);
  }
  // hazard: `runtimeHome()` reads `process.env` and would ignore the env passed in, which made this untestable
  // and would have read the wrong home for any caller that supplies one.
  const home = env.TLC_HOME?.trim();
  return home && home.length > 0 ? resolve(home) : conventionalRuntimeHome();
}

export function installRuntime(source: string, dest: string): InstallReport {
  if (resolve(source) === resolve(dest)) {
    // why: the git route already has the code at the destination. Copying a directory onto itself is the one
    // input that turns a sync into data loss.
    return { kind: "in-place", source, dest, entries: [], missing: [] };
  }
  mkdirSync(dest, { recursive: true });
  const entries: string[] = [];
  const missing: string[] = [];
  for (const entry of RUNTIME_PAYLOAD) {
    const from = join(source, entry);
    if (!existsSync(from)) {
      missing.push(entry);
      continue;
    }
    const to = join(dest, entry);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, {
      recursive: true,
      filter: (src) => isShipped(relative(source, src)),
    });
    entries.push(entry);
  }
  // why: a directory with no `.git` used to classify as `unmanaged`, which doctor reports as a failure and update
  // answers with "re-install with the one-liner". The marker is how the thing that created this directory says
  // what it is, rather than leaving every later reader to guess from the contents.
  writeFileSync(
    join(dest, NPM_MARKER),
    `Installed by \`tlc harness install\` from ${source}.\nUpdate with: npm i -g ${NPM_PACKAGE}@latest && tlc harness install\n`,
    "utf8",
  );
  const config = join(dest, "config.json");
  const example = join(dest, "config.example.json");
  if (!existsSync(config) && existsSync(example)) {
    writeFileSync(config, readFileSync(example, "utf8"), "utf8");
  }
  return { kind: "copied", source, dest, entries, missing };
}

/**
 * The contributor route: the runtime home points at a checkout, so an edit is live in the next hook with no
 * install step.
 *
 * why it is here and not in a shell script: it was `ln -sfn` in bash and `mklink /J` in PowerShell, and the
 * PowerShell one asked for Developer Mode. One `symlinkSync` covers all three platforms
 * ([/decisions/ad-097.md](/decisions/ad-097.md)).
 *
 * invariant: the checkout is never written to, and a destination that is not already a link is refused rather
 * than removed ([/decisions/ad-046.md](/decisions/ad-046.md)).
 */
export function linkRuntime(source: string, dest: string): InstallReport {
  if (resolve(source) === resolve(dest)) {
    return { kind: "in-place", source, dest, entries: [], missing: [] };
  }
  const outcome = linkDir(resolve(source), dest);
  if (outcome.kind === "refused") {
    return { kind: "refused", source, dest, entries: [], missing: [], reason: outcome.reason };
  }
  const missing = RUNTIME_PAYLOAD.filter((entry) => !existsSync(join(dest, entry)));
  return { kind: outcome.kind === "relinked" ? "relinked" : "linked", source, dest, entries: [], missing };
}

export function installScreen(report: InstallReport): Screen {
  if (report.kind === "refused") {
    return {
      title: "harness install",
      sections: [{ rows: [{ label: "refused", value: report.reason ?? "", level: "fail" }] }],
    };
  }
  if (report.kind === "linked" || report.kind === "relinked") {
    return {
      title: "harness install",
      sections: [
        {
          rows: [
            {
              label: report.kind === "linked" ? "linked" : "relinked",
              value: `${report.dest} → ${report.source}`,
              level: "ok",
            },
            ...(report.missing.length > 0
              ? [
                  {
                    label: "incomplete",
                    value: `the checkout has no ${report.missing.join(", ")} — run the build`,
                    level: "fail" as const,
                  },
                ]
              : []),
          ],
        },
      ],
      footer: "an edit in the checkout is live in the next hook  ·  `npm link` puts `tlc` on PATH",
    };
  }
  if (report.kind === "in-place") {
    return {
      title: "harness install",
      sections: [
        { rows: [{ label: "runtime", value: `already at ${report.dest} — nothing to copy`, level: "ok" }] },
      ],
    };
  }
  const rows: Row[] = [
    { label: "installed", value: `${report.entries.length} path(s) → ${report.dest}`, level: "ok" },
    { label: "from", value: report.source },
  ];
  if (report.missing.length > 0) {
    // why: a payload entry absent from the source is a packaging fault, not a passing install. `tools/` was
    // missing from the published `files` list the first time this ran.
    rows.push({
      label: "packaging",
      value: `MISSING from the source: ${report.missing.join(", ")}`,
      level: "fail",
    });
  }
  return { title: "harness install", sections: [{ rows }] };
}

export function installReportText(report: InstallReport, style: Style = PLAIN): string {
  return render(installScreen(report), style);
}

/**
 * hazard: not the resolved home. On the very first npm run nothing is installed yet, so the resolved home *is*
 * the package — and asking it where to install would answer "here", which is the one place that cannot hold
 * state. The conventional path is the answer unless the operator named one themselves.
 */
export function installDest(env: NodeJS.ProcessEnv = process.env): string {
  // hazard: the destination cannot be carried on `TLC_HOME`. Setting that makes the launcher resolve the runtime
  // to a directory that does not exist yet on a first install, and it then refuses for want of the bundles it was
  // being asked to put there. A separate variable keeps resolution and destination independent.
  const explicit = env.TLC_INSTALL_DEST?.trim();
  if (explicit && explicit.length > 0) {
    return resolve(explicit);
  }
  return runtimeHomeWasChosen(env) ? runtimeHome(env) : conventionalRuntimeHome();
}

/**
 * The first price fetch, on the machine, at install time.
 *
 * why: prices are no longer in the package, so a fresh install has no catalogue at all until something fetches
 * one. This is that something ([/decisions/ad-096.md](/decisions/ad-096.md)).
 *
 * invariant: never fails the install. An operator installing behind a proxy, on a plane, or against a page that
 * moved still gets a working harness — they get no cost figures until the next refresh, which `doctor` reports.
 */
export function fetchPrices(dest: string, spawn = spawnSync): void {
  const result = spawn(process.execPath, [join(dest, "bin", "tlc-exec.mjs"), "refresh-model-prices"], {
    stdio: "inherit",
    env: { ...process.env, TLC_HOME: dest },
  });
  if ((result.status ?? 1) !== 0) {
    console.log("install: prices not fetched — cost estimates stay empty until `tlc harness prices refresh`");
  }
}

if (import.meta.main) {
  /**
   * why a flag rather than a second command: install is install. The only difference is whether the runtime home
   * holds a copy of the package or points at a checkout ([/decisions/ad-097.md](/decisions/ad-097.md)).
   */
  const link = process.argv.includes("--link");
  const source = link ? process.cwd() : originRoot();
  const dest = installDest();
  const report = link ? linkRuntime(source, dest) : installRuntime(source, dest);
  console.log(installReportText(report, createStyle()));
  if (report.kind === "refused") {
    process.exit(1);
  }
  fetchPrices(dest);
  process.exit(report.missing.length > 0 ? 1 : 0);
}
