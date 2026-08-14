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

Related: [/architecture.md](/architecture.md), [/concepts.md](/concepts.md), [/providers/index.md](/providers/index.md).
