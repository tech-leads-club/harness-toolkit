---
type: Aggregate
title: "Decisions index"
description: "Index of every architectural decision made while building the multi-provider harness, by number. See /log.md for the same records by date."
tags: [decisions, index]
timestamp: "2026-07-29"
---

# Decisions

Each architectural decision (AD) lives in its own file, cross-linked from here. This index replaces the
`## Decisions` section that used to live in `.specs/STATE.md` — see [/index.md](/index.md) for the rest of
the documentation bundle. `.specs/STATE.md` (outside this bundle, at the repo root) now keeps only the
Handoff section and a link back to this index.

| # | Title | Status |
| --- | --- | --- |
| [AD-001](/decisions/ad-001.md) | Optional parent-Fast sticky deny for Task spawns | active |
| [AD-002](/decisions/ad-002.md) | Provider-neutral naming and layout | active |
| [AD-003](/decisions/ad-003.md) | No backward compatibility | active |
| [AD-004](/decisions/ad-004.md) | Ports and adapters with an anti-corruption layer per provider | active |
| [AD-005](/decisions/ad-005.md) | Local test runner is the gate; CI matrix runs on every push | active |
| [AD-006](/decisions/ad-006.md) | Windows is covered by CI, minus the installer and the editor end | active |
| [AD-007](/decisions/ad-007.md) | Vendor check applies to core tests; absence checks do not | active |
| [AD-008](/decisions/ad-008.md) | Biome + TypeScript in the gate; `@types/node` pinned to the declared floor | active |
| [AD-009](/decisions/ad-009.md) | Event kinds are provider-agnostic; capabilities are data, not flags | active |
| [AD-010](/decisions/ad-010.md) | Shared vocabulary moves to `src/contracts/` | active |
| [AD-011](/decisions/ad-011.md) | Vendor-specific data belongs to the provider, not to core | active |
| [AD-012](/decisions/ad-012.md) | Prefer Bun at runtime, keep `dist/` for the Node fallback, ship no binary | active |
| [AD-013](/decisions/ad-013.md) | Documentation follows the Open Knowledge Format (OKF v0.1) | active |
| [AD-014](/decisions/ad-014.md) | Claude Code hook payload field paths, pinned | active |
| [AD-015](/decisions/ad-015.md) | Wiring handler names are the entrypoint filenames | active |
| [AD-016](/decisions/ad-016.md) | Field semantics, state writers, and the core export surface | active |
| [AD-017](/decisions/ad-017.md) | The docs gate delegates to the project's tool, and the catalog is the only source of capability metadata | active |
| [AD-018](/decisions/ad-018.md) | Three rails adopted from an external review, each off by default and declared rather than inferred | active |
| [AD-019](/decisions/ad-019.md) | A resource is identified by what it resolves to, and a declared capability must be read where it matters | active |
| [AD-020](/decisions/ad-020.md) | One resolution for the install path, one source for posture, and a config that only advertises what it reads | active |
| [AD-021](/decisions/ad-021.md) | A gate command that never resolved is a config fault, and a recipe runner does not receive file arguments | active |
| [AD-022](/decisions/ad-022.md) | The policy surface is a floor rule, detection sits behind interception, and the operator/agent line is structural | active |
| [AD-023](/decisions/ad-023.md) | One finding per failure, and lesson relevance is recurrence rather than exposure | active |
| [AD-024](/decisions/ad-024.md) | The gate tells the truth about its own environment, its own lock, and the cause of a failure | active |
| [AD-025](/decisions/ad-025.md) | Posture governs surfacing only, and each posture has exactly one name | active |
| [AD-026](/decisions/ad-026.md) | An interruption is worth what it costs: narrower asks, a deadline on questions, and a rate the operator can see | active |
| [AD-027](/decisions/ad-027.md) | Evidence is ordered against the code, every rail's firing is recorded, and a checker can run with its rule off | active |
| [AD-028](/decisions/ad-028.md) | A resolved failure is kept, a session attests to itself, and provider neutrality becomes a proof | active |
| [AD-029](/decisions/ad-029.md) | A capability the init skill cannot correctly initialise is not shipped | active |
| [AD-030](/decisions/ad-030.md) | Clearing a policy divergence is one operator command behind four independent locks, and a refusal never points an agent at a door the floor holds shut | active |
| [AD-031](/decisions/ad-031.md) | The decisions are the changelog, a breaking change carries its own instruction, and looking never changes anything | active |
| [AD-032](/decisions/ad-032.md) | A hook is healthy when it can run, not when a marker string is present | active |
| [AD-033](/decisions/ad-033.md) | The gate says what it costs, appendFiles stops promising what it cannot deliver, and a dead capability leaves | active |
| [AD-034](/decisions/ad-034.md) | A warning that fires on a healthy install is not a warning, and the author reads the operator's output before anyone else does | active |
| [AD-035](/decisions/ad-035.md) | A lesson learned by reasoning can be written down, and the harness never learns where lessons come from | active |
| [AD-036](/decisions/ad-036.md) | A lesson names what makes it true, and stops being injected when that is gone | active |
| [AD-037](/decisions/ad-037.md) | A lesson can be true for a period, and an unparseable bound withholds it | active |
| [AD-038](/decisions/ad-038.md) | Promotion counts distinct sessions, because one stuck session is one observation | active |
| [AD-039](/decisions/ad-039.md) | A lesson is graded by the gate it was injected for, and unproven is not a passing reading | active |
| [AD-040](/decisions/ad-040.md) | Three lesson tiers, and nothing crosses between products by itself | active |
| [AD-041](/decisions/ad-041.md) | A member something reads and nothing writes fails the gate | active |
| [AD-042](/decisions/ad-042.md) | The suite gets an empty runtime home, and one renderer renders a lesson | active |
| [AD-043](/decisions/ad-043.md) | A standing rule is pinned, not ranked, and the budget says what it dropped | active |
| [AD-044](/decisions/ad-044.md) | Only an injection a gate could grade can be unproven | active |
| [AD-045](/decisions/ad-045.md) | A gate verdict is reused when the content hash of its inputs did not change | active |
| [AD-046](/decisions/ad-046.md) | The runtime path is an artifact, and update never touches what it does not own | active |
| [AD-047](/decisions/ad-047.md) | An instruction is not an affordance, and a refusal names the route that works | active |
| [AD-048](/decisions/ad-048.md) | A broken updater cannot deliver its own fix, so the installer is the recovery route | active |
| [AD-049](/decisions/ad-049.md) | An empty synced file says which of four reasons made it empty | active |
| [AD-050](/decisions/ad-050.md) | Lesson transport is a provider capability, not an operator preference | active |
| [AD-051](/decisions/ad-051.md) | A warning fails the gate, and a suppression states what breaks without it | active |
| [AD-052](/decisions/ad-052.md) | The repository moves to the org and the runtime paths do not | active |
| [AD-053](/decisions/ad-053.md) | The harness ships no model allowlist, and a list that names nothing enforces nothing | active |
| [AD-054](/decisions/ad-054.md) | npm is the distribution, and a merged release PR is the only thing that publishes | active |
| [AD-055](/decisions/ad-055.md) | The changelog is rendered from the decision records, and git says which release each landed in | active |
| [AD-056](/decisions/ad-056.md) | The package delivers the runtime, and the runtime path stays where hooks already point | active |
| [AD-057](/decisions/ad-057.md) | The release PR is a mechanism, not a gate, and the bot merges it | active |
| [AD-058](/decisions/ad-058.md) | Gates diff against the turn's base, and language knowledge is one table | active |
| [AD-059](/decisions/ad-059.md) | A rail never writes a field it reads, and a counter reads the plane its events land on | active |
| [AD-060](/decisions/ad-060.md) | The gate records the environment it ran under, and names it only once the cheap explanations are spent | active |
| [AD-061](/decisions/ad-061.md) | A decision that refuses names its rule, and degrading preserves it | active |
| [AD-062](/decisions/ad-062.md) | One command answers whether the harness did that, and says so plainly when it did not | active |
| [AD-063](/decisions/ad-063.md) | One palette for human output, and a checker keeping it out of everything else | active |
| [AD-064](/decisions/ad-064.md) | A snapshot is assigned, never accumulated, and a table does not list what it cannot count | active |
| [AD-065](/decisions/ad-065.md) | The obs bus has a contract, and the gate checks both sides of it | active |
| [AD-066](/decisions/ad-066.md) | Uninstall reads the artefact, and the plan is the confirmation | active |
| [AD-067](/decisions/ad-067.md) | A reserved file that cannot be retired is rendered, and the gate holds it there | active |
| [AD-068](/decisions/ad-068.md) | A directory decides what ships, and dist is derived from disk in both directions | active |
| [AD-069](/decisions/ad-069.md) | A decision record declares its shape, and cites by link so a move cannot break it | active |
| [AD-070](/decisions/ad-070.md) | A comment has to read for somebody who was not in the session | active |
| [AD-071](/decisions/ad-071.md) | The turn's added lines are checked against the code the project already has | active |
| [AD-072](/decisions/ad-072.md) | A record can leave the corpus, and removing is a change worth recording | active |
| [AD-073](/decisions/ad-073.md) | A neighbour mid-gate is not a reason to block a turn | active |
| [AD-074](/decisions/ad-074.md) | Code the gate cannot read is refused, and a credential is not always a file | active |
| [AD-075](/decisions/ad-075.md) | A dependency a turn adds outlives the turn, so two mechanical failures are worth a stop | active |
| [AD-076](/decisions/ad-076.md) | Goal-hijack enforcement needs the tool output, and the host does not deliver it | active |
| [AD-077](/decisions/ad-077.md) | A command that appears verbatim in fetched content is put to the operator | active |
| [AD-078](/decisions/ad-078.md) | The two files the harness reads aloud are sealed on write and verified on injection | active |
| [AD-079](/decisions/ad-079.md) | The coverage claim is a generated page with its gaps in it, not a badge in the README | active |
| [AD-080](/decisions/ad-080.md) | Every hand-written list of our own rules is now checked, including the one that drifted while writing this | active |
| [AD-081](/decisions/ad-081.md) | The manifest npm publishes is checked here, because the release runner was the only thing reading it | active |
| [AD-082](/decisions/ad-082.md) | npm is the documented install, and the first version cannot come from CI | active |
| [AD-083](/decisions/ad-083.md) | Going public switched the branch ruleset on, and an unattended release needs the App to bypass it | active |
| [AD-084](/decisions/ad-084.md) | The rule about unpinned dependencies is applied to this repository too, and the release gate stops being a copy | active |
| [AD-085](/decisions/ad-085.md) | The flake was a test measuring a file the whole machine writes to | active |
| [AD-086](/decisions/ad-086.md) | The write lock read the wrong error code on Windows, in a module that already listed the right ones | active |
| [AD-087](/decisions/ad-087.md) | How the release works, and the six wrong shapes it took first | active |
| [AD-095](/decisions/ad-095.md) | Four defects about where things are written, and one of them made every hook run twice | active |
| [AD-096](/decisions/ad-096.md) | Prices are the machine's, in one file, and the parser that fills it was wrong twice | active |
| [AD-097](/decisions/ad-097.md) | The shell layer goes, and with it every platform branch that only existed because of it | active |
| [AD-098](/decisions/ad-098.md) | Code splitting cut dist/ ninefold and broke three commands, so it is reverted until no library module self-executes | active |
| [AD-099](/decisions/ad-099.md) | Reading a file claimed it, so a review agent locked the operator out of writing | active |
| [AD-100](/decisions/ad-100.md) | The operator declares the trigger and the proof; the harness enforces it | active |
| [AD-101](/decisions/ad-101.md) | Machine data belongs to the machine, not to the install | active |
| [AD-102](/decisions/ad-102.md) | A green gate is not a working product, so four checks that look where it cannot | active |
| [AD-103](/decisions/ad-103.md) | The artefact is proven where operators install it, and an inert scope has to be telling the truth | active |
| [AD-104](/decisions/ad-104.md) | A subagent proof names the type the spawn declared, never the name the spawning agent chose | active |
| [AD-105](/decisions/ad-105.md) | Anyone may use it, including a company; nobody may sell it as a service, and the notices travel with it | active |
| [AD-106](/decisions/ad-106.md) | A build step's own exit code cannot be the publish guarantee when it is also a recovery path | active |
| [AD-107](/decisions/ad-107.md) | A subagent's own budget running out is not evidence about the tree, and a stuck handoff now has an exit | active |
| [AD-108](/decisions/ad-108.md) | Two fields in the unfinished-work formula had no writer, and the carried-gap merge dropped this turn's own result | active |
| [AD-109](/decisions/ad-109.md) | A lesson's credit is graded by the session that earned it, not by whichever session runs the gate next | active |
| [AD-110](/decisions/ad-110.md) | The documented ship-gate excludes promised two paths core is not allowed to name | active |
| [AD-111](/decisions/ad-111.md) | The comment gate advises at edit-time, cheap enough to afford per edit; duplication stays stop-only | active |
| [AD-112](/decisions/ad-112.md) | A codegen tool's own banner is not agent narration | active |
| [AD-113](/decisions/ad-113.md) | `tlc harness policy accept` resolves a relative path against root | active |
| [AD-114](/decisions/ad-114.md) | Rule proof `since HEAD` resolves sha from the event's own working directory, not the project root | active |
| [AD-115](/decisions/ad-115.md) | A comment violation refuses commit, push and gh pr create, not only the stop | active |
| [AD-116](/decisions/ad-116.md) | push and gh pr create run the stop-time battery before shipping, identically on every provider | active |
| [AD-117](/decisions/ad-117.md) | turn_base_sha resolves sha from the event's own working directory, not the project root | active |
| [AD-118](/decisions/ad-118.md) | pr-open does not fire on a draft, so a proof needing the pull request to exist has a way to run | active |
| [AD-119](/decisions/ad-119.md) | A rule's denial says whether the proof never ran or ran outside the window | active |
| [AD-120](/decisions/ad-120.md) | A rule denial names the directory and sha it actually checked | active |

## Archived

A record moves here when its decision is complete and its body would no longer guide a future change. It keeps
its row in `CHANGELOG.md` and in [/log.md](/log.md), because it shipped; this index is the only view that
separates the two, because it is the only one that claims to say what currently binds. Value decides, never
volume — see the archive rule in `CONTRIBUTING.md`.

None yet.

Related: [/architecture.md](/architecture.md), [/concepts.md](/concepts.md), [/providers/index.md](/providers/index.md).
