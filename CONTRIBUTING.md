# Contributing

## License

PolyForm Noncommercial 1.0.0 (`LICENSE`, `NOTICE`).

## Install

```bash
npm i -g @tech-leads-club/harness-toolkit
tlc harness install
```

Target path: `~/.tlc/harness`.

## Contribute from a clone

A contributor install **links** the runtime path at your clone instead of materialising a copy, so an edit is live
in the next hook without any install step. `tlc harness doctor` reports it as `link to a working clone`, and
`update` never writes there.

```bash
git clone https://github.com/tech-leads-club/harness-toolkit.git
cd harness-toolkit
./install.sh      # run from the checkout, it links rather than clones
./bin/tlc-build
```

Windows: `.\install.ps1`, which needs Developer Mode or an elevated shell for the symlink.

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
| 5 | `check-boundaries` | `core/` importing `providers/`, or a vendor identifier under `src/core` or `src/contracts` |
| 6 | `check-suppressions` | a lint suppression whose reason is not a reason — step 1 cannot see a rule that was silenced rather than fixed |
| 7 | `check-wiring` | a declared union member that is read and never written |
| 8 | `check-docs-bundle` | a broken link or a doc outside the bundle's shape |
| 9 | `check-decisions` | a decision record off the required shape, a status outside the closed set, or an AD cited by bare number instead of a link |
| 10 | `check-screens` | a terminal renderer that paints its own strings instead of going through the shared one |
| 11 | `check-obs-contract` | a kind a consumer counts and no producer emits, or one landing on a plane the consumer does not read |
| 12 | `check-manifest` | a `package.json` npm would rewrite on publish, or a `bin` entry pointing at a file that is not there |
| 13 | `check-workflows` | a third-party GitHub Action referenced by tag instead of a commit SHA, or a SHA with no version comment |
| 14 | `render-capabilities --check` | a generated README region that no longer matches `capabilities/catalog.json` |
| 15 | `render-changelog --check` | a `CHANGELOG.md` that no longer matches `docs/decisions/` |
| 16 | `render-log --check` | a `docs/log.md` that no longer matches `docs/decisions/` |
| 17 | `render-coverage --check` | a control named in `docs/coverage.md` that is neither a floor rule nor a capability id, or a row short of `covered` that states no limit |
| 18 | `check-dist-fresh` | **CI only** — a `dist/` bundle that does not match `src/`. Run `./bin/tlc-build` and commit the result |

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
node tools/dev/check-workflows.ts
node tools/dev/render-capabilities.ts --check
node tools/dev/render-changelog.ts --check
node tools/dev/render-log.ts --check
node tools/dev/render-coverage.ts --check
node tools/dev/check-dist-fresh.ts
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
