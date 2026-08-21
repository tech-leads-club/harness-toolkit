# Contributing

## License

PolyForm Noncommercial 1.0.0 (`LICENSE`, `NOTICE`).

## Install

```bash
npm i -g @tech-leads-club/harness-toolkit && tlc harness install
```

Target path: `~/.tlc/harness`.

## Contribute from a clone

`--link` points the runtime path at your clone instead of materialising a copy, so an edit is live in the next hook
with no install step. `tlc harness doctor` reports it as `link to a working clone`, and `update` never writes there.

```bash
git clone https://github.com/tech-leads-club/harness-toolkit.git
cd harness-toolkit
npm ci
node bin/tlc-build.mjs                    # dist/ is not committed
node bin/tlc.mjs harness install --link
npm link                                  # optional: puts `tlc` on PATH from this clone
```

Same commands on Linux, macOS and Windows. Needs Node 24+ and Bun (the bundler).

## Checks

The gate is a single command:

```bash
tlc harness test
```

Eighteen steps, in order. The list lives in `harnessTestSteps` in `bin/tlc-cli.ts` — that function is the
source of truth, and this table is here to say what each step is for.

| # | Step | Fails on |
|---|---|---|
| 1 | `biome check --error-on-warnings` | any lint or format finding, including warn-level ones |
| 2 | `tsc --noEmit` | a type error |
| 3 | src suite | `src/**/__test__/*.test.ts` |
| 4 | tools suite | `tools/__test__/*.test.ts` — a flat glob, so a new tool test must sit directly in `tools/__test__/` |
| 5 | `knip --files --dependencies` | a file nothing imports, or a dependency nothing uses — both are at zero, so both block |
| 6 | `knip --exports --max-issues N` | the count of unused exports growing past the ceiling in `bin/tlc-cli.ts`. `observe` was exported, wired into the facade and called by nothing while 113 tests passed; this is the check that sees that. **Measured limit:** a dead export added to `src/platform/paths.ts` or `links.ts` is not reported, while four other files probed are — cause not found, so do not read this step as complete coverage ([/decisions/ad-102.md](/decisions/ad-102.md)) |
| 7 | `check-boundaries` | `core/` importing `providers/`, or a vendor identifier under `src/core` or `src/contracts` |
| 8 | `check-suppressions` | a lint suppression whose reason is not a reason — step 1 cannot see a rule that was silenced rather than fixed |
| 9 | `check-wiring` | a declared union member that is read and never written |
| 10 | `check-docs-bundle` | a broken link or a doc outside the bundle's shape |
| 11 | `check-decisions` | a decision record off the required shape, a status outside the closed set, or an AD cited by bare number instead of a link |
| 12 | `check-screens` | a terminal renderer that paints its own strings instead of going through the shared one |
| 13 | `check-obs-contract` | a kind a consumer counts and no producer emits, or one landing on a plane the consumer does not read |
| 14 | `check-manifest` | a `package.json` npm would rewrite on publish, or a `bin` entry pointing at a file that is not there |
| 15 | `render-capabilities --check` | a generated README region that no longer matches `capabilities/catalog.json` |
| 16 | `render-changelog --check` | a `CHANGELOG.md` that no longer matches `docs/decisions/` |
| 17 | `render-log --check` | a `docs/log.md` that no longer matches `docs/decisions/` |
| 18 | `render-coverage --check` | a control named in `docs/coverage.md` that is neither a floor rule nor a capability id, or a row short of `covered` that states no limit |

Equivalent by hand, for local debugging:

```bash
npx biome check --error-on-warnings
npx tsc --noEmit
node --import ./tools/test-env.mjs --test "src/**/__test__/*.test.ts"
node --import ./tools/test-env.mjs --test "tools/__test__/*.test.ts"
node tools/dev/check-boundaries.ts
node tools/dev/check-suppressions.ts
node tools/dev/check-wiring.ts
node tools/dev/check-docs-bundle.ts
node tools/dev/check-decisions.ts
node tools/dev/check-screens.ts
node tools/dev/check-obs-contract.ts
node tools/dev/check-manifest.ts
node tools/dev/render-capabilities.ts --check
node tools/dev/render-changelog.ts --check
node tools/dev/render-log.ts --check
node tools/dev/render-coverage.ts --check
```

`--import ./tools/test-env.mjs` is not optional. Without it a suite reads `CLAUDE_PROJECT_DIR` from
whatever shell started it, so tests that build a fixture in a temp directory resolve against this
repository instead — green from a terminal, red from inside a hook.

Run the suites in three environments before pushing, because the runtime home and the project directory
are both resolved from the environment:

```bash
tlc harness test
TLC_HOME="$PWD" tlc harness test
CLAUDE_PROJECT_DIR="$PWD" TLC_PROJECT_DIR="$PWD" tlc harness test
```

### What the gate deliberately cannot see

The suite runs against the working tree with a fake home, which is what keeps it from writing into yours — and it is
also what it cannot speak about. Three checks live outside it for that reason
([/decisions/ad-102.md](/decisions/ad-102.md), [/decisions/ad-103.md](/decisions/ad-103.md)):

```bash
node tools/dev/verify-package.mjs                                  # the artefact, on this platform
node tools/dev/verify-package.mjs --from <name@version>            # the published artefact, from the registry
node tools/dev/check-scopes.ts --base origin/main                  # an inert scope that changes what ships
```

The first packs the tarball, asserts its payload against npm's own file list, installs it into a throwaway npm
prefix with a scratch home the way `npx` would, and drives `version`, `install` and `doctor`. It is a release step,
not a gate step: it resolves dependencies from the network. It spawns one process per step and composes no shell,
which is what lets the same script run on Linux, macOS and Windows — in the release pipeline it runs on all three
before anything is published.

Three install defects reached operators through this gap — 0.3.0 installed nothing, 0.3.2 shipped bundles where
every entry answered as the CLI, 0.4.0 left `tlc` off `PATH`. Every one was found by a person on their own machine,
and until this ran on three platforms the artefact was only ever installed on one.

`check-scopes` reads a commit range, so it runs on the pull request rather than here. `fix(gate)` and the other
inert scopes never release; this is what checks that a commit wearing one is really plumbing, and not a fix an
operator needs that will now wait for somebody else's release to carry it.

The Windows leg of CI is the third. A POSIX path assumption in a test passes on every developer machine here and
fails there, which is exactly what happened — twice — and the check worked both times.

## Releasing

A push to `main` releases. Nothing to run, nothing to approve, and no credential anywhere: trusted publishing mints
a short-lived OIDC token per run and npm checks it against the registered publisher — organisation, repository,
workflow filename, environment name — so there is no stored secret to steal and nothing to rotate. Provenance is
generated from that same identity ([/decisions/ad-102.md](/decisions/ad-102.md)).

**What makes it safe is the gate, not a gate-keeper:** eighteen steps on four platforms, then the packed tarball
installed and driven as a real command on Linux, macOS and Windows, then a human approval, and only then
`npm publish`. After it, the version that reached the registry is installed from the registry on the same three
platforms — which cannot prevent anything, and turns "an operator finds it days later" into "the run goes red in
minutes" ([/decisions/ad-103.md](/decisions/ad-103.md)).

The order matters and is argued in the workflow itself: the artefact is proven **before** the approval, because the
approval is a person deciding to make something irreversible.

Two settings outside this repository decide whether "tokenless" is true or merely available:

- **Require OIDC** on npmjs.com, which *disables* token publishing for the package. Without it a token still works
  and the property is optional. npm's publish emails say `via OIDC` or `via token`, which is how you check.
- **Required reviewers** on the `publish` environment. With them, every release waits for a human; without them it
  is unattended. The environment itself must keep its name either way, because the trusted publisher is registered
  against it.

There is no rollback, and no amount of tooling invents one: npm versions are immutable and re-pointing `latest`
needs an automation token. The recovery for a bad version is the next patch, which this same pipeline ships in
minutes — so `0.4.2` was fixed by `0.4.3`, not by undoing anything.

Two shapes were tried before this and both were worse. A `next` dist-tag needs a token, because trusted publishing
does not cover `npm dist-tag`. `npm stage publish` is tokenless but no workflow can finish it — every stage
subcommand except `publish` requires proof of presence — so it turns every release into a manual step and buys
nothing the gate did not already give.

## Decision records

`docs/decisions/` holds one record per decision. Four headings are required — `## Decision`, a heading beginning
`## Why`, `## Trade-offs`, `## Not decided here` — and `tools/dev/check-decisions.ts` checks them. AD-001 through
AD-020 predate the shape and sit behind a ratchet that may only fall; migrating one means lowering
`LEGACY_SHAPE_BUDGET` in the same change.

Cite a record by link, never by number: `[/decisions/ad-046.md](/decisions/ad-046.md)`. A link survives a file
move and the bundle check resolves it.

### When a record leaves

Move it to `docs/decisions/archived/` and set `- **status**: archived`. It keeps its row in `CHANGELOG.md` and
`docs/log.md`, because it shipped; only `docs/decisions/index.md` distinguishes the two, because only the index
claims to say what currently binds.

**Value decides, never volume.** Keep a record active while its alternatives, its ownership boundary, its
negative guarantee, its security rule, or its condition for reintroduction would still change what somebody
does. Archive one whose decision is complete and whose body would not guide a future change — a closed defect, a
narrow adapter, superseded implementation detail. Length and age are how you find candidates, never how you judge
them, and there is no target count.

### Removing is a change like any other

A record whose subject is *removing* something is worth writing, and the corpus had none for a long time while
gaining sixty-seven that added. When you are deciding whether something can go:

- A symbol, event, config field or export with no production consumer is a candidate.
- **A test that pins behaviour nothing load-bearing depends on is evidence *for* removal, not against it.** The
  suite is not the specification; the specification is what a consumer needs.
- **A decision record is not authority for current behaviour either.** If the code and a record disagree, one of
  them is wrong and finding out which is the work.
- `tools/dev/check-wiring.ts` and `tools/dev/check-obs-contract.ts` already report what nothing reads. Those
  lists are where to look first, and they are reports rather than failures precisely because the judgement is
  yours.

## Changing the init skill

The wizard has two halves. `skills/harness-init/references/capabilities.md` is generated from
`capabilities/catalog.json` — never edit it. `skills/harness-init/SKILL.md` is hand-written and narrates three
capabilities in prose; the gate fails if one of those three gains a mode the skill does not name.

The skill's `description` is what decides whether a host routes a request to it at all, so a change there is a
behaviour change with no test attached. Before changing it, run the routing evaluation:

```bash
ANTHROPIC_API_KEY=... node tools/dev/eval-skill-triggers.ts --json
```

It reports which phrasings route and which do not. Without a key it exits 0 and says so, so it is safe to run
blind. Nothing invokes it automatically — the point of naming it here is that a change to the description has a
documented step rather than an orphaned tool ([/decisions/ad-080.md](/decisions/ad-080.md)).

## Conventions

- Prefer clear names over narrating comments.
- Do not add lint suppressions to silence gates.
- Ship claims use `HARNESS_SHIP_CLAIM: …` only.
- `core/` and `contracts/` never contain a vendor identifier (`cursor`, `claude`, `codex`, `composer`,
  `anthropic`) — see [`docs/decisions/ad-004.md`](docs/decisions/ad-004.md) and
  [`docs/decisions/ad-007.md`](docs/decisions/ad-007.md).
- Documentation under `docs/` is an OKF v0.1 bundle — new docs need `type`/`title`/`description`/`tags`/
  `timestamp` frontmatter and absolute bundle-relative links. See
  [`docs/decisions/ad-013.md`](docs/decisions/ad-013.md).

## Price catalogs

See `tlc harness help prices` or [`docs/measure.md`](docs/measure.md).
