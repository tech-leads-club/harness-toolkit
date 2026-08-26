import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { flagsDir, projectConfigPath, projectStateDir } from "../../../platform/paths.ts";
import {
  acceptPolicySources,
  allDivergedPaths,
  checkPolicyBaseline,
  divergedPaths,
  policySourceFingerprint,
  recordPolicyBaseline,
  refreshPolicyBaselines,
} from "../policy.integrity.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newRoot(config = '{"version":1}'): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-integrity-"));
  roots.push(root);
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  mkdirSync(projectStateDir(root), { recursive: true });
  writeFileSync(projectConfigPath(root), config, "utf8");
  return root;
}

test("a missing baseline is recorded and allowed, never blocked", () => {
  const root = newRoot();
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");
  // why: the first hook of every session lands here; blocking would break every fresh session.
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");
});

test("an unchanged policy is allowed", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");
});

test("an out-of-band config change is denied and names the file", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(projectConfigPath(root), '{"version":1,"grind":{"enabled":false}}', "utf8");

  const decision = checkPolicyBaseline(root, "s1");
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.match(decision.reason, /changed during this session/);
    assert.ok(decision.reason.includes(projectConfigPath(root)));
  }
});

test("creating a flag file out of band is denied", () => {
  // why: `skip-verify` disables the stop checks without the config file being touched at all.
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  mkdirSync(flagsDir(root), { recursive: true });
  writeFileSync(join(flagsDir(root), "skip-verify"), "", "utf8");

  assert.equal(checkPolicyBaseline(root, "s1").kind, "deny");
});

test("writing the mode file out of band is denied", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(join(projectStateDir(root), "harness-mode"), "solo", "utf8");

  assert.equal(checkPolicyBaseline(root, "s1").kind, "deny");
});

test("deleting the config is a divergence, not an unchanged reading", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  rmSync(projectConfigPath(root));

  assert.equal(checkPolicyBaseline(root, "s1").kind, "deny");
});

test("refreshing the baselines clears the block, which is how a harness command reports itself", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(projectConfigPath(root), '{"version":1,"mode":"solo"}', "utf8");
  assert.equal(checkPolicyBaseline(root, "s1").kind, "deny");

  refreshPolicyBaselines(root);
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");
});

test("refresh reaches every live session, because the CLI cannot know which are live", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  recordPolicyBaseline(root, "s2");
  writeFileSync(projectConfigPath(root), '{"version":1,"mode":"paired"}', "utf8");

  refreshPolicyBaselines(root);
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");
  assert.equal(checkPolicyBaseline(root, "s2").kind, "allow");
});

test("sessions keep independent baselines", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(projectConfigPath(root), '{"version":2}', "utf8");
  // why: s2 starts after the change, so the change is its baseline — an operator edit between sessions is
  // the operator's prerogative and must not surface as tampering.
  recordPolicyBaseline(root, "s2");

  assert.equal(checkPolicyBaseline(root, "s1").kind, "deny");
  assert.equal(checkPolicyBaseline(root, "s2").kind, "allow");
});

test("a session key that is not a safe filename still works", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "provider/../weird key");
  assert.equal(checkPolicyBaseline(root, "provider/../weird key").kind, "allow");
  writeFileSync(projectConfigPath(root), "{}", "utf8");
  assert.equal(checkPolicyBaseline(root, "provider/../weird key").kind, "deny");
});

test("a missing config file hashes as absent rather than throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "tlc-integrity-"));
  roots.push(root);
  const sources = policySourceFingerprint(root);
  assert.ok(sources.length >= 3);
  assert.ok(sources.every((source) => typeof source.hash === "string" && source.hash.length > 0));
  assert.equal(sources[0]?.hash, "absent");
});

test("the fingerprint covers every source the loader reads", () => {
  const root = newRoot();
  const paths = policySourceFingerprint(root).map((source) => source.path);
  assert.ok(paths.includes(projectConfigPath(root)));
  assert.ok(paths.includes(join(projectStateDir(root), "harness-mode")));
  for (const flag of ["grind-on", "skip-verify", "focus", "paired"]) {
    assert.ok(paths.includes(join(flagsDir(root), flag)), flag);
  }
});

// invariant: accepting one source leaves the others diverged. `refreshPolicyBaselines` rewrites the whole
// fingerprint, so using it here would silently bless every other change alongside the one named — the hole this
// closes ([/decisions/ad-030.md](/decisions/ad-030.md)).
test("accepting one diverged source leaves a second one blocking", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(projectConfigPath(root), '{"version":2}', "utf8");
  mkdirSync(flagsDir(root), { recursive: true });
  writeFileSync(join(flagsDir(root), "skip-verify"), "", "utf8");

  const diverged = divergedPaths(root, "s1");
  assert.equal(diverged.length, 2);

  const outcome = acceptPolicySources(root, [projectConfigPath(root)]);
  assert.equal(outcome.kind, "accepted");
  assert.equal(checkPolicyBaseline(root, "s1").kind, "deny", "the flag change must still block");

  acceptPolicySources(root, [join(flagsDir(root), "skip-verify")]);
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");
});

test("accepting reaches every live session, because the CLI cannot know which are live", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  recordPolicyBaseline(root, "s2");
  writeFileSync(projectConfigPath(root), '{"version":3}', "utf8");
  acceptPolicySources(root, [projectConfigPath(root)]);
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");
  assert.equal(checkPolicyBaseline(root, "s2").kind, "allow");
});

// invariant: no blanket permission is expressible. The accepted hash is the hash at that moment, so the next change
// to the same file diverges again.
test("accepting does not stop the harness watching that source", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(projectConfigPath(root), '{"version":2}', "utf8");
  acceptPolicySources(root, [projectConfigPath(root)]);
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");

  writeFileSync(projectConfigPath(root), '{"version":3}', "utf8");
  assert.equal(checkPolicyBaseline(root, "s1").kind, "deny", "a later change must diverge again");
});

test("a path the loader never reads is refused, and the real sources are named", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  const outcome = acceptPolicySources(root, [join(root, "src", "app.ts")]);
  assert.equal(outcome.kind, "not-a-source");
  if (outcome.kind === "not-a-source") {
    assert.ok(outcome.sources.includes(projectConfigPath(root)));
  }
});

test("a relative path resolves against root and is accepted the same as the absolute one", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(projectConfigPath(root), '{"version":2}', "utf8");
  const outcome = acceptPolicySources(root, [".tlc/harness/config.json"]);
  assert.equal(outcome.kind, "accepted");
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");
});

test("with no baseline recorded there is nothing to accept, and it is not an error", () => {
  const root = newRoot();
  assert.equal(acceptPolicySources(root, [projectConfigPath(root)]).kind, "nothing-to-accept");
});

test("a deleted source accepts as absent, which is its current state", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  rmSync(projectConfigPath(root));
  assert.equal(checkPolicyBaseline(root, "s1").kind, "deny");
  acceptPolicySources(root, [projectConfigPath(root)]);
  assert.equal(checkPolicyBaseline(root, "s1").kind, "allow");
});

test("allDivergedPaths is the union across sessions, sorted", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(projectConfigPath(root), '{"version":2}', "utf8");
  recordPolicyBaseline(root, "s2");
  mkdirSync(flagsDir(root), { recursive: true });
  writeFileSync(join(flagsDir(root), "grind-on"), "", "utf8");

  const all = allDivergedPaths(root);
  assert.ok(all.includes(projectConfigPath(root)), "s1's divergence");
  assert.ok(all.includes(join(flagsDir(root), "grind-on")), "s2's divergence");
  assert.deepEqual(all, [...all].sort());
});

// hazard: the reason used to end "the harness commands re-record the baseline when they write", and the floor
// refuses every one of those from inside a session. A blocked agent read it as a route, tried one, and stayed
// blocked. `reason` reaches the agent; `userNote` reaches the operator.
test("the refusal tells the agent to report and tells the operator the command", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(projectConfigPath(root), '{"version":9}', "utf8");
  const decision = checkPolicyBaseline(root, "s1");
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.match(decision.reason, /Report this to the operator/);
    assert.match(decision.reason, /nothing for you to run here/);
    assert.match(decision.userNote ?? "", /tlc harness policy accept/);
    assert.match(
      decision.userNote ?? "",
      new RegExp(projectConfigPath(root).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")),
    );
    assert.equal(decision.rule, "policy-baseline-divergence");
  }
});

test("the refusal names every diverged path, not just the first", () => {
  const root = newRoot();
  recordPolicyBaseline(root, "s1");
  writeFileSync(projectConfigPath(root), '{"version":2}', "utf8");
  mkdirSync(flagsDir(root), { recursive: true });
  writeFileSync(join(flagsDir(root), "focus"), "", "utf8");
  const decision = checkPolicyBaseline(root, "s1");
  if (decision.kind === "deny") {
    assert.match(decision.reason, /focus/);
    assert.match(decision.reason, /config\.json/);
  }
});
