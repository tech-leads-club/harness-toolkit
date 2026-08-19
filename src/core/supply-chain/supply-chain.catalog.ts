/**
 * A dependency manifest, its lockfile, and how a version is written in it.
 *
 * why: one table, the way the comment gate keeps one table of comment delimiters. A manifest is recognised by
 * filename and nothing else, so adding an ecosystem is a row rather than a parser
 * ([/decisions/ad-075.md](/decisions/ad-075.md)).
 *
 * invariant: a filename absent from here produces no findings and is reported as unknown. Guessing that a file
 * called `deps.txt` pins versions the way `requirements.txt` does is how a checker starts refusing honest work.
 */
export type ManifestEntry = {
  manifest: string;
  /** Null when the ecosystem has no separate lockfile, so `unlocked` cannot apply. */
  lockfile: string | null;
  /**
   * How a dependency line reads. `json-object` is `"name": "spec"`; `requirement` is `name==spec` or `name>=spec`
   * on its own line; `toml-table` is `name = "spec"`; `directive` is `require name spec`.
   */
  shape: "json-object" | "requirement" | "toml-table" | "directive";
};

/**
 * hazard: PHP is absent, and not for a technical reason. Its manifest filename contains a word this project's
 * boundary check forbids anywhere under `src/core` because it is also a provider's agent name
 * ([/decisions/ad-004.md](/decisions/ad-004.md)). The architecture rule is worth more than one row, so the row
 * goes and the reason is stated rather than a suppression invented
 * ([/decisions/ad-075.md](/decisions/ad-075.md)).
 */
export const MANIFESTS: readonly ManifestEntry[] = [
  { manifest: "package.json", lockfile: "package-lock.json", shape: "json-object" },
  { manifest: "requirements.txt", lockfile: null, shape: "requirement" },
  { manifest: "pyproject.toml", lockfile: "poetry.lock", shape: "toml-table" },
  { manifest: "Cargo.toml", lockfile: "Cargo.lock", shape: "toml-table" },
  { manifest: "go.mod", lockfile: "go.sum", shape: "directive" },
  { manifest: "Gemfile", lockfile: "Gemfile.lock", shape: "directive" },
];

export function manifestFor(relativePath: string): ManifestEntry | null {
  const name = relativePath.split(/[\\/]/).pop() ?? relativePath;
  return MANIFESTS.find((entry) => entry.manifest === name) ?? null;
}

/** why: the alternative lockfiles an ecosystem accepts. A project using pnpm has locked just as firmly as one using npm. */
export const ALTERNATE_LOCKFILES: Readonly<Record<string, readonly string[]>> = {
  "package.json": ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json", "bun.lockb"],
  "pyproject.toml": ["poetry.lock", "pdm.lock", "uv.lock"],
};

export function lockfilesFor(entry: ManifestEntry): readonly string[] {
  return ALTERNATE_LOCKFILES[entry.manifest] ?? (entry.lockfile === null ? [] : [entry.lockfile]);
}
