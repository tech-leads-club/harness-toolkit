# Changelog

Generated from `docs/decisions/` — do not edit by hand. Run `node tools/render-changelog.ts`.

Each entry is an architectural decision record: what changed, why, what was refused, and what it costs.
A **Needs your action** line is a change `tlc harness doctor` cannot detect for you; everything else
doctor reports against your own configuration.

## Unreleased

- **AD-001** — Optional parent-Fast sticky deny for Task spawns
- **AD-002** — Provider-neutral naming and layout
- **AD-003** — No backward compatibility
- **AD-004** — Ports and adapters with an anti-corruption layer per provider
- **AD-005** — Local test runner is the gate; CI matrix runs on every push
- **AD-006** — Windows ships in scope, with CI covering the suite and the build
- **AD-007** — Vendor check applies to core tests; absence checks do not
- **AD-008** — Biome + TypeScript in the gate; @types/node pinned to the declared floor
- **AD-009** — Event kinds are provider-agnostic; capabilities are data, not flags
- **AD-010** — Shared vocabulary moves to src/contracts/
- **AD-011** — Vendor-specific data belongs to the provider, not to core
- **AD-012** — Prefer Bun at runtime, keep dist/ for the Node fallback, ship no binary
- **AD-013** — Documentation follows the Open Knowledge Format (OKF v0.1)
- **AD-014** — Claude Code hook payload field paths, pinned
- **AD-015** — Wiring handler names are the entrypoint filenames
- **AD-016** — Field semantics, state writers, and the core export surface
- **AD-017** — The docs gate delegates to the project's tool, and the catalog is the only source of capability metadata
- **AD-018** — Three rails adopted from an external review, each off by default and declared rather than inferred
- **AD-019** — A resource is identified by what it resolves to, and a declared capability must be read where it matters
- **AD-020** — One resolution for the install path, one source for posture, and a config that only advertises what it reads
- **AD-021** — A gate command that never resolved is a config fault, and a recipe runner does not receive file arguments
- **AD-022** — The policy surface is a floor rule, detection sits behind interception, and the operator/agent line is structural
- **AD-023** — One finding per failure, and lesson relevance is recurrence rather than exposure
- **AD-024** — The gate tells the truth about its own environment, its own lock, and the cause of a failure
- **AD-025** — Posture governs surfacing only, and each posture has exactly one name
- **AD-026** — An interruption is worth what it costs: narrower asks, a deadline on questions, and a rate the operator can see
- **AD-027** — Evidence is ordered against the code, every rail's firing is recorded, and a checker can run with its rule off
  - **Needs your action:** Re-run your verification after the last code change before citing the verdict — the ship gate now refuses evidence written before the code it certifies, so a claim that used to pass can block. Nothing in doctor can see this one; it shows up as a blocked stop.
- **AD-028** — A resolved failure is kept, a session attests to itself, and provider neutrality becomes a proof
- **AD-029** — A capability the init skill cannot correctly initialise is not shipped
- **AD-030** — Clearing a policy divergence is one operator command behind four independent locks, and a refusal never points an agent at a door the floor holds shut
- **AD-031** — The decisions are the changelog, a breaking change carries its own instruction, and looking never changes anything
- **AD-032** — A hook is healthy when it can run, not when a marker string is present
- **AD-033** — The gate says what it costs, appendFiles stops promising what it cannot deliver, and a dead capability leaves
- **AD-034** — A warning that fires on a healthy install is not a warning, and the author reads the operator's output before anyone else does
- **AD-035** — A lesson learned by reasoning can be written down, and the harness never learns where lessons come from
- **AD-036** — A lesson names what makes it true, and stops being injected when that is gone
- **AD-037** — A lesson can be true for a period, and an unparseable bound withholds it
- **AD-038** — Promotion counts distinct sessions, because one stuck session is one observation
- **AD-039** — A lesson is graded by the gate it was injected for, and unproven is not a passing reading
- **AD-040** — Three lesson tiers, and nothing crosses between products by itself
- **AD-041** — A member something reads and nothing writes fails the gate
- **AD-042** — The suite gets an empty runtime home, and one renderer renders a lesson
- **AD-043** — A standing rule is pinned, not ranked, and the budget says what it dropped
- **AD-044** — Only an injection a gate could grade can be unproven
- **AD-045** — A gate verdict is reused when the content hash of its inputs did not change
- **AD-046** — The runtime path is an artifact, and update never touches what it does not own
- **AD-047** — An instruction is not an affordance, and a refusal names the route that works
- **AD-048** — A broken updater cannot deliver its own fix, so the installer is the recovery route
- **AD-049** — An empty synced file says which of four reasons made it empty
- **AD-050** — Lesson transport is a provider capability, not an operator preference
- **AD-051** — A warning fails the gate, and a suppression states what breaks without it
- **AD-052** — The repository moves to the org and the runtime paths do not
- **AD-053** — The harness ships no model allowlist, and a list that names nothing enforces nothing
- **AD-054** — npm is the distribution, and a merged release PR is the only thing that publishes
- **AD-055** — The changelog is rendered from the decision records, and git says which release each landed in
- **AD-056** — The package delivers the runtime, and the runtime path stays where hooks already point
- **AD-057** — The release PR is a mechanism, not a gate, and the bot merges it
- **AD-058** — Gates diff against the turn's base, and language knowledge is one table
  - **Needs your action:** If a project has the comment gate on, expect it to start firing on turns that commit and on languages it never covered. Nothing changes in your config.
- **AD-059** — A rail never writes a field it reads, and a counter reads the plane its events land on
- **AD-060** — The gate records the environment it ran under, and names it only once the cheap explanations are spent
- **AD-061** — A decision that refuses names its rule, and degrading preserves it
- **AD-062** — One command answers whether the harness did that, and says so plainly when it did not
- **AD-063** — One palette for human output, and a checker keeping it out of everything else
- **AD-064** — A snapshot is assigned, never accumulated, and a table does not list what it cannot count
- **AD-065** — The obs bus has a contract, and the gate checks both sides of it
- **AD-066** — Uninstall reads the artefact, and the plan is the confirmation
- **AD-067** — A reserved file that cannot be retired is rendered, and the gate holds it there
- **AD-068** — A directory decides what ships, and dist is derived from disk in both directions
- **AD-069** — A decision record declares its shape, and cites by link so a move cannot break it
- **AD-070** — A comment has to read for somebody who was not in the session
- **AD-071** — The turn's added lines are checked against the code the project already has
- **AD-072** — A record can leave the corpus, and removing is a change worth recording
- **AD-073** — A neighbour mid-gate is not a reason to block a turn
- **AD-074** — Code the gate cannot read is refused, and a credential is not always a file
- **AD-075** — A dependency a turn adds outlives the turn, so two mechanical failures are worth a stop
