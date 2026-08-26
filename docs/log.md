---
type: Aggregate
title: "Documentation log"
description: "Chronological, ISO 8601 record of every architectural decision, grouped by the date it was taken. Generated from docs/decisions/."
tags: [log, history, okf]
timestamp: "2026-08-12"
---

# Log

Generated from `docs/decisions/` — do not edit by hand. Run `node tools/render-log.ts`.

A reserved file of the [OKF v0.1](/decisions/ad-013.md) bundle: entries grouped under ISO 8601 headings,
newest first. For what landed in which npm release, see `CHANGELOG.md` at the repository root.

## 2026-08-26

- **AD-106** — A build step's own exit code cannot be the publish guarantee when it is also a recovery path ([/decisions/ad-106.md](/decisions/ad-106.md))
- **AD-107** — A subagent's own budget running out is not evidence about the tree, and a stuck handoff now has an exit ([/decisions/ad-107.md](/decisions/ad-107.md))
- **AD-108** — Two fields in the unfinished-work formula had no writer, and the carried-gap merge dropped this turn's own result ([/decisions/ad-108.md](/decisions/ad-108.md))
- **AD-109** — A lesson's credit is graded by the session that earned it, not by whichever session runs the gate next ([/decisions/ad-109.md](/decisions/ad-109.md))
- **AD-110** — The documented ship-gate excludes promised two paths core is not allowed to name ([/decisions/ad-110.md](/decisions/ad-110.md))

## 2026-08-22

- **AD-104** — A subagent proof names the type the spawn declared, never the name the spawning agent chose ([/decisions/ad-104.md](/decisions/ad-104.md))
- **AD-105** — Anyone may use it, including a company; nobody may sell it as a service, and the notices travel with it ([/decisions/ad-105.md](/decisions/ad-105.md))

## 2026-08-21

- **AD-100** — The operator declares the trigger and the proof; the harness enforces it ([/decisions/ad-100.md](/decisions/ad-100.md))
- **AD-101** — Machine data belongs to the machine, not to the install ([/decisions/ad-101.md](/decisions/ad-101.md))
- **AD-102** — A green gate is not a working product, so four checks that look where it cannot ([/decisions/ad-102.md](/decisions/ad-102.md))
- **AD-103** — The artefact is proven where operators install it, and an inert scope has to be telling the truth ([/decisions/ad-103.md](/decisions/ad-103.md))

## 2026-08-20

- **AD-098** — Splitting is reverted: a shared chunk ran the CLI's main ([/decisions/ad-098.md](/decisions/ad-098.md))
- **AD-099** — Reading a file claimed it, so a review agent locked the operator out of writing ([/decisions/ad-099.md](/decisions/ad-099.md))

## 2026-08-19

- **AD-081** — The manifest npm publishes is checked here, because the release runner was the only thing reading it ([/decisions/ad-081.md](/decisions/ad-081.md))
- **AD-082** — npm is the documented install, and the first version cannot come from CI ([/decisions/ad-082.md](/decisions/ad-082.md))
- **AD-083** — Going public switched the branch ruleset on, and an unattended release needs the App to bypass it ([/decisions/ad-083.md](/decisions/ad-083.md))
- **AD-084** — The rule about unpinned dependencies is applied to this repository too, and the release gate stops being a copy ([/decisions/ad-084.md](/decisions/ad-084.md))
- **AD-085** — The flake was a test measuring a file the whole machine writes to ([/decisions/ad-085.md](/decisions/ad-085.md))
- **AD-086** — The write lock read the wrong error code on Windows, in a module that already listed the right ones ([/decisions/ad-086.md](/decisions/ad-086.md))
- **AD-087** — How the release works, and the six wrong shapes it took first ([/decisions/ad-087.md](/decisions/ad-087.md))
- **AD-095** — Four defects about where things are written, and one of them made every hook run twice ([/decisions/ad-095.md](/decisions/ad-095.md))
- **AD-096** — Prices are the machine's, in one file, and the parser that fills it was wrong twice ([/decisions/ad-096.md](/decisions/ad-096.md))
- **AD-097** — The shell layer goes, and with it every platform branch that only existed because of it ([/decisions/ad-097.md](/decisions/ad-097.md))

## 2026-08-17

- **AD-073** — A neighbour mid-gate is not a reason to block a turn ([/decisions/ad-073.md](/decisions/ad-073.md))
- **AD-074** — Code the gate cannot read is refused, and a credential is not always a file ([/decisions/ad-074.md](/decisions/ad-074.md))
- **AD-075** — A dependency a turn adds outlives the turn, so two mechanical failures are worth a stop ([/decisions/ad-075.md](/decisions/ad-075.md))
- **AD-076** — Goal-hijack enforcement needs the tool's output, and the host does not deliver it ([/decisions/ad-076.md](/decisions/ad-076.md))
- **AD-077** — A command that appears verbatim in fetched content is put to the operator ([/decisions/ad-077.md](/decisions/ad-077.md))
- **AD-078** — The two files the harness reads aloud are sealed on write and verified on injection ([/decisions/ad-078.md](/decisions/ad-078.md))
- **AD-079** — The coverage claim is a generated page with its gaps in it, not a badge in the README ([/decisions/ad-079.md](/decisions/ad-079.md))
- **AD-080** — Every hand-written list of our own rules is now checked, including the one that drifted while writing this ([/decisions/ad-080.md](/decisions/ad-080.md))

## 2026-08-13

- **AD-068** — A directory decides what ships, and dist is derived from disk in both directions ([/decisions/ad-068.md](/decisions/ad-068.md))
- **AD-069** — A decision record declares its shape, and cites by link so a move cannot break it ([/decisions/ad-069.md](/decisions/ad-069.md))
- **AD-070** — A comment has to read for somebody who was not in the session ([/decisions/ad-070.md](/decisions/ad-070.md))
- **AD-071** — The turn's added lines are checked against the code the project already has ([/decisions/ad-071.md](/decisions/ad-071.md))
- **AD-072** — A record can leave the corpus, and removing is a change worth recording ([/decisions/ad-072.md](/decisions/ad-072.md))

## 2026-08-12

- **AD-060** — The gate records the environment it ran under, and names it only once the cheap explanations are spent ([/decisions/ad-060.md](/decisions/ad-060.md))
- **AD-061** — A decision that refuses names its rule, and degrading preserves it ([/decisions/ad-061.md](/decisions/ad-061.md))
- **AD-062** — One command answers whether the harness did that, and says so plainly when it did not ([/decisions/ad-062.md](/decisions/ad-062.md))
- **AD-063** — One palette for human output, and a checker keeping it out of everything else ([/decisions/ad-063.md](/decisions/ad-063.md))
- **AD-064** — A snapshot is assigned, never accumulated, and a table does not list what it cannot count ([/decisions/ad-064.md](/decisions/ad-064.md))
- **AD-065** — The obs bus has a contract, and the gate checks both sides of it ([/decisions/ad-065.md](/decisions/ad-065.md))
- **AD-066** — Uninstall reads the artefact, and the plan is the confirmation ([/decisions/ad-066.md](/decisions/ad-066.md))
- **AD-067** — A reserved file that cannot be retired is rendered, and the gate holds it there ([/decisions/ad-067.md](/decisions/ad-067.md))

## 2026-08-10

- **AD-058** — Gates diff against the turn's base, and language knowledge is one table ([/decisions/ad-058.md](/decisions/ad-058.md))
- **AD-059** — A rail never writes a field it reads, and a counter reads the plane its events land on ([/decisions/ad-059.md](/decisions/ad-059.md))

## 2026-08-07

- **AD-054** — npm is the distribution, and a merged release PR is the only thing that publishes ([/decisions/ad-054.md](/decisions/ad-054.md))
- **AD-055** — The changelog is rendered from the decision records, and git says which release each landed in ([/decisions/ad-055.md](/decisions/ad-055.md))
- **AD-056** — The package delivers the runtime, and the runtime path stays where hooks already point ([/decisions/ad-056.md](/decisions/ad-056.md))
- **AD-057** — The release PR is a mechanism, not a gate, and the bot merges it ([/decisions/ad-057.md](/decisions/ad-057.md))

## 2026-08-06

- **AD-053** — The harness ships no model allowlist, and a list that names nothing enforces nothing ([/decisions/ad-053.md](/decisions/ad-053.md))

## 2026-08-05

- **AD-045** — A gate verdict is reused when the content hash of its inputs did not change ([/decisions/ad-045.md](/decisions/ad-045.md))
- **AD-046** — The runtime path is an artifact, and update never touches what it does not own ([/decisions/ad-046.md](/decisions/ad-046.md))
- **AD-047** — An instruction is not an affordance, and a refusal names the route that works ([/decisions/ad-047.md](/decisions/ad-047.md))
- **AD-048** — A broken updater cannot deliver its own fix, so the installer is the recovery route ([/decisions/ad-048.md](/decisions/ad-048.md))
- **AD-049** — An empty synced file says which of four reasons made it empty ([/decisions/ad-049.md](/decisions/ad-049.md))
- **AD-050** — Lesson transport is a provider capability, not an operator preference ([/decisions/ad-050.md](/decisions/ad-050.md))
- **AD-051** — A warning fails the gate, and a suppression states what breaks without it ([/decisions/ad-051.md](/decisions/ad-051.md))
- **AD-052** — The repository moves to the org and the runtime paths do not ([/decisions/ad-052.md](/decisions/ad-052.md))

## 2026-08-04

- **AD-024** — The gate tells the truth about its own environment, its own lock, and the cause of a failure ([/decisions/ad-024.md](/decisions/ad-024.md))
- **AD-025** — Posture governs surfacing only, and each posture has exactly one name ([/decisions/ad-025.md](/decisions/ad-025.md))
- **AD-026** — An interruption is worth what it costs: narrower asks, a deadline on questions, and a rate the operator can see ([/decisions/ad-026.md](/decisions/ad-026.md))
- **AD-027** — Evidence is ordered against the code, every rail's firing is recorded, and a checker can run with its rule off ([/decisions/ad-027.md](/decisions/ad-027.md))
- **AD-028** — A resolved failure is kept, a session attests to itself, and provider neutrality becomes a proof ([/decisions/ad-028.md](/decisions/ad-028.md))
- **AD-029** — A capability the init skill cannot correctly initialise is not shipped ([/decisions/ad-029.md](/decisions/ad-029.md))
- **AD-030** — Clearing a policy divergence is one operator command behind four independent locks, and a refusal never points an agent at a door the floor holds shut ([/decisions/ad-030.md](/decisions/ad-030.md))
- **AD-031** — The decisions are the changelog, a breaking change carries its own instruction, and looking never changes anything ([/decisions/ad-031.md](/decisions/ad-031.md))
- **AD-032** — A hook is healthy when it can run, not when a marker string is present ([/decisions/ad-032.md](/decisions/ad-032.md))
- **AD-033** — The gate says what it costs, appendFiles stops promising what it cannot deliver, and a dead capability leaves ([/decisions/ad-033.md](/decisions/ad-033.md))
- **AD-034** — A warning that fires on a healthy install is not a warning, and the author reads the operator's output before anyone else does ([/decisions/ad-034.md](/decisions/ad-034.md))
- **AD-035** — A lesson learned by reasoning can be written down, and the harness never learns where lessons come from ([/decisions/ad-035.md](/decisions/ad-035.md))
- **AD-036** — A lesson names what makes it true, and stops being injected when that is gone ([/decisions/ad-036.md](/decisions/ad-036.md))
- **AD-037** — A lesson can be true for a period, and an unparseable bound withholds it ([/decisions/ad-037.md](/decisions/ad-037.md))
- **AD-038** — Promotion counts distinct sessions, because one stuck session is one observation ([/decisions/ad-038.md](/decisions/ad-038.md))
- **AD-039** — A lesson is graded by the gate it was injected for, and unproven is not a passing reading ([/decisions/ad-039.md](/decisions/ad-039.md))
- **AD-040** — Three lesson tiers, and nothing crosses between products by itself ([/decisions/ad-040.md](/decisions/ad-040.md))
- **AD-041** — A member something reads and nothing writes fails the gate ([/decisions/ad-041.md](/decisions/ad-041.md))
- **AD-042** — The suite gets an empty runtime home, and one renderer renders a lesson ([/decisions/ad-042.md](/decisions/ad-042.md))
- **AD-043** — A standing rule is pinned, not ranked, and the budget says what it dropped ([/decisions/ad-043.md](/decisions/ad-043.md))
- **AD-044** — Only an injection a gate could grade can be unproven ([/decisions/ad-044.md](/decisions/ad-044.md))

## 2026-08-03

- **AD-023** — One finding per failure, and lesson relevance is recurrence rather than exposure ([/decisions/ad-023.md](/decisions/ad-023.md))

## 2026-07-31

- **AD-022** — The policy surface is a floor rule, detection sits behind interception, and the operator/agent line is structural ([/decisions/ad-022.md](/decisions/ad-022.md))

## 2026-07-30

- **AD-017** — The docs gate delegates to the project's tool, and the catalog is the only source of capability metadata ([/decisions/ad-017.md](/decisions/ad-017.md))
- **AD-018** — Three rails adopted from an external review, each off by default and declared rather than inferred ([/decisions/ad-018.md](/decisions/ad-018.md))
- **AD-019** — A resource is identified by what it resolves to, and a declared capability must be read where it matters ([/decisions/ad-019.md](/decisions/ad-019.md))
- **AD-020** — One resolution for the install path, one source for posture, and a config that only advertises what it reads ([/decisions/ad-020.md](/decisions/ad-020.md))
- **AD-021** — A gate command that never resolved is a config fault, and a recipe runner does not receive file arguments ([/decisions/ad-021.md](/decisions/ad-021.md))

## 2026-07-29

- **AD-002** — Provider-neutral naming and layout ([/decisions/ad-002.md](/decisions/ad-002.md))
- **AD-003** — No backward compatibility ([/decisions/ad-003.md](/decisions/ad-003.md))
- **AD-004** — Ports and adapters with an anti-corruption layer per provider ([/decisions/ad-004.md](/decisions/ad-004.md))
- **AD-005** — Local test runner is the gate; CI matrix runs on every push ([/decisions/ad-005.md](/decisions/ad-005.md))
- **AD-006** — Windows ships in scope, with CI covering the suite and the build ([/decisions/ad-006.md](/decisions/ad-006.md))
- **AD-007** — Vendor check applies to core tests; absence checks do not ([/decisions/ad-007.md](/decisions/ad-007.md))
- **AD-008** — Biome + TypeScript in the gate; @types/node pinned to the declared floor ([/decisions/ad-008.md](/decisions/ad-008.md))
- **AD-009** — Event kinds are provider-agnostic; capabilities are data, not flags ([/decisions/ad-009.md](/decisions/ad-009.md))
- **AD-010** — Shared vocabulary moves to src/contracts/ ([/decisions/ad-010.md](/decisions/ad-010.md))
- **AD-011** — Vendor-specific data belongs to the provider, not to core ([/decisions/ad-011.md](/decisions/ad-011.md))
- **AD-012** — Prefer Bun at runtime, keep dist/ for the Node fallback, ship no binary ([/decisions/ad-012.md](/decisions/ad-012.md))
- **AD-013** — Documentation follows the Open Knowledge Format (OKF v0.1) ([/decisions/ad-013.md](/decisions/ad-013.md))
- **AD-014** — Claude Code hook payload field paths, pinned ([/decisions/ad-014.md](/decisions/ad-014.md))
- **AD-015** — Wiring handler names are the entrypoint filenames ([/decisions/ad-015.md](/decisions/ad-015.md))
- **AD-016** — Field semantics, state writers, and the core export surface ([/decisions/ad-016.md](/decisions/ad-016.md))

## 2026-07-27

- **AD-001** — Optional parent-Fast sticky deny for Task spawns ([/decisions/ad-001.md](/decisions/ad-001.md))
