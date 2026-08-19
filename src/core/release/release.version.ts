/**
 * How a release tag is spelled.
 *
 * hazard: the changelog generator listed tags with the glob `v*` while every tag this repository has ever created
 * is `harness-toolkit-v…`. It matched none, put all 88 decision records under `## Unreleased`, and passed its own
 * `--check` because the generated document and the committed one were wrong in the same way. Three releases shipped
 * with a changelog attributing nothing to any of them ([/decisions/ad-087.md](/decisions/ad-087.md)).
 *
 * invariant: derived from the package name, which is the same source `release-please-config.json` writes the tag
 * from. A prefix written down twice is a prefix that drifts once.
 */
export function tagPrefixFor(packageName: string): string {
  const unscoped = packageName.includes("/") ? (packageName.split("/").pop() ?? packageName) : packageName;
  return `${unscoped}-v`;
}

export type SemVer = { major: number; minor: number; patch: number };

export function parseVersion(text: string): SemVer | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (match === null) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** The version inside a tag, or null when the tag belongs to another package or another scheme. */
export function versionInTag(packageName: string, tag: string): string | null {
  const prefix = tagPrefixFor(packageName);
  if (!tag.startsWith(prefix)) {
    return null;
  }
  const rest = tag.slice(prefix.length);
  return parseVersion(rest) === null ? null : rest;
}
