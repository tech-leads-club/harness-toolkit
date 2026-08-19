/**
 * Where the init skill has to be linked, and what counts as a link that works.
 *
 * hazard: `install.sh` loops over every provider config directory that exists and links
 * `<provider>/skills/harness-init`, with the comment "Each provider only reads its own skills directory".
 * `tlc harness update` linked to `<runtime-home>/../skills/harness-init` instead — a directory no provider reads,
 * and which did not exist at all on the machine where this was found. So an update never refreshed the skill
 * anywhere a provider looks, and the evidence was a link left pointing into a `/tmp` recovery directory that does
 * not survive a reboot ([/decisions/ad-095.md](/decisions/ad-095.md)).
 *
 * invariant: one function, used by both, so the two cannot disagree again.
 */

export const SKILL_NAME = "harness-init";

export type SkillLink = { providerDir: string; source: string; target: string };

/**
 * why: the provider directories are given rather than resolved here. Both tools relocate their config directory by
 * environment variable, and this repository is itself installed under a relocated one — so the caller resolves and
 * this decides.
 */
export function skillLinks(
  runtimeHome: string,
  providerDirs: readonly string[],
  present: (path: string) => boolean,
) {
  const source = `${runtimeHome}/skills/${SKILL_NAME}`;
  return providerDirs
    .filter((dir) => present(dir))
    .map((providerDir) => ({
      providerDir,
      source,
      target: `${providerDir}/skills/${SKILL_NAME}`,
    }));
}

export type LinkHealth =
  | { state: "ok"; target: string; resolved: string }
  | { state: "dangling"; target: string; resolved: string }
  | { state: "outside-runtime"; target: string; resolved: string }
  | { state: "absent"; target: string };

/**
 * hazard: a link whose destination does not exist reads as installed to anything that only checks the link. The
 * one found on the machine that prompted this pointed at `/tmp/tlc-recovery-…/install/skills/harness-init` — a
 * directory from a recovery run, gone on the next boot, and invisible to every check the harness had.
 *
 * invariant: a link that resolves outside the runtime home is reported even when it currently exists, because
 * a source that is not the runtime is a source that will move.
 *
 * hazard: BOTH sides have to be resolved. The first version compared the link's realpath against the runtime home
 * as configured, and on a contributor install — where `~/.tlc/harness` is a symlink to a working clone, which
 * `doctor` reports as healthy — the two never share a prefix. It printed two failures on a machine where nothing
 * was wrong, which is the reading AD-034 exists to forbid: a warning that fires on a healthy install is not a
 * warning ([/decisions/ad-095.md](/decisions/ad-095.md)).
 */
export function linkHealth(
  target: string,
  runtimeHome: string,
  probe: {
    linkTarget: (path: string) => string | null;
    exists: (path: string) => boolean;
    realpath?: (path: string) => string;
  },
): LinkHealth {
  const resolved = probe.linkTarget(target);
  if (resolved === null) {
    return { state: "absent", target };
  }
  if (!probe.exists(resolved)) {
    return { state: "dangling", target, resolved };
  }
  const resolveHome = probe.realpath ?? ((path: string) => path);
  const home = resolveHome(runtimeHome).replace(/\/+$/, "");
  return resolved === home || resolved.startsWith(`${home}/`)
    ? { state: "ok", target, resolved }
    : { state: "outside-runtime", target, resolved };
}

export function linkHealthMessage(health: LinkHealth): string {
  switch (health.state) {
    case "ok":
      return `linked → ${health.resolved}`;
    case "dangling":
      return `points at ${health.resolved}, which does not exist — re-run \`tlc harness install\``;
    case "outside-runtime":
      return `points at ${health.resolved}, outside the runtime — it will break when that path goes`;
    default:
      return "not linked — the provider cannot see the init skill";
  }
}
