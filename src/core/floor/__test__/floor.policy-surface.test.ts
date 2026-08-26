import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeHome, runtimeStateDir } from "../../../platform/paths.ts";
import { checkPolicySurface } from "../floor.policy-surface.ts";
import { evaluateFloor } from "../floor.service.ts";
import { tokenizeShell } from "../floor.tokenize.ts";

const PROJECT = "/home/dev/project";
const CONFIG = ".tlc/harness/config.json";
const HANDOFF = ".tlc/harness/state/handoff.json";

function verdict(command: string) {
  return checkPolicySurface(PROJECT, command, tokenizeShell(command));
}

function assertDenied(command: string): void {
  assert.equal(verdict(command).kind, "deny", `expected deny for: ${command}`);
}

function assertAllowed(command: string): void {
  assert.equal(verdict(command).kind, "allow", `expected allow for: ${command}`);
}

test("an interpreter writing the policy file is denied", () => {
  // why: this is the command from the incident that motivated the rule — it passed the tool guard by
  // never touching a write tool.
  assertDenied(`python3 -c "import json; json.dump({}, open('${CONFIG}','w'))"`);
  assertDenied(`python3 - <<'PY'\nopen('${CONFIG}','w')\nPY`);
  assertDenied(`perl -pi -e s/a/b/ ${CONFIG}`);
  assertDenied(`node --eval "require('fs').writeFileSync('${CONFIG}','{}')" ${CONFIG}`);
  assertDenied(`ruby -e 'x' ${CONFIG}`);
});

test("known writers on the policy surface are denied", () => {
  assertDenied(`sed -i s/a/b/ ${CONFIG}`);
  assertDenied(`tee ${CONFIG}`);
  assertDenied(`cp /tmp/other ${CONFIG}`);
  assertDenied(`mv /tmp/other ${CONFIG}`);
  assertDenied(`truncate -s 0 ${CONFIG}`);
  assertDenied(`chmod 777 ${CONFIG}`);
});

test("redirects into the policy surface are denied in every spelling", () => {
  assertAllowed("cat /tmp/other > /tmp/copy");
  assertDenied(`cat /tmp/other > ${CONFIG}`);
  assertDenied(`cat /tmp/other >${CONFIG}`);
  assertDenied(`cat /tmp/other >>${CONFIG}`);
  assertDenied(`echo {}>${CONFIG}`);
  assertDenied(`printf '{}' > ${join(PROJECT, CONFIG)}`);
  assertDenied(`cat /tmp/x > ${HANDOFF}`);
});

test("proven readers on the policy surface are allowed", () => {
  // why: the bootstrap instructs the agent to read handoff.json, and inspecting the config is ordinary
  // investigation. A rule that broke these would be a misfire, not a gate.
  assertAllowed(`cat ${HANDOFF}`);
  assertAllowed(`head -20 ${CONFIG}`);
  assertAllowed(`grep testCommand ${CONFIG}`);
  assertAllowed(`jq .grind ${CONFIG}`);
  assertAllowed(`wc -l ${CONFIG}`);
  assertAllowed(`diff ${CONFIG} /tmp/other`);
  assertAllowed(`ls -la ${join(PROJECT, ".tlc/harness/state")}`);
  assertAllowed(`stat ${CONFIG}`);
});

test("echo and printf name the surface without being able to touch it", () => {
  // hazard: this rule denied its own end-to-end verification — `printf '{...config.json...}' | node hook`
  // has printf as a head verb that names the path. Neither echo nor printf can modify a file on its own;
  // only a redirect can, and redirects are judged separately, as the next assertions show.
  assertAllowed(`printf '{"file":"${CONFIG}"}' | node dist/tool-before.mjs`);
  assertAllowed(`echo "see ${CONFIG}"`);
  assertDenied(`echo '{}' > ${CONFIG}`);
  assertDenied(`printf '{}' >> ${CONFIG}`);
});

test("git is a reader only for subcommands that cannot write", () => {
  assertAllowed(`git show HEAD:${CONFIG}`);
  assertAllowed(`git diff HEAD -- ${CONFIG}`);
  assertAllowed(`git log --oneline -- ${CONFIG}`);
  assertAllowed(`git ls-files ${CONFIG}`);
  assertDenied(`git checkout -- ${CONFIG}`);
  assertDenied(`git restore ${CONFIG}`);
  assertDenied(`git apply ${CONFIG}`);
  assertDenied(`git clean -fd ${CONFIG}`);
});

test("a target that cannot be established is denied", () => {
  assertDenied(`cp /tmp/x "$CFG/.tlc/harness/config.json"`);
  assertDenied(`echo x > .tlc/harness/$name`);
  assertDenied(`sh -c "echo x > ${CONFIG}`);
});

test("removing a directory that contains the surface is denied", () => {
  assertDenied(`rm -rf ${join(PROJECT, ".tlc/harness/state")}`);
  assertDenied("rm -rf .tlc/harness");
  assertDenied("rm -rf .tlc");
  assertDenied("rm -rf .tlc/harness/state/flags");
});

test("ordinary work near the project root is untouched", () => {
  // hazard: the project root also contains the policy surface. Counting it as a reference would deny the
  // most common commands there are, which is why the root is excluded by name.
  assertAllowed("find . -name '*.ts'");
  assertAllowed("grep -r testCommand .");
  assertAllowed("rm -rf node_modules");
  assertAllowed("rm -rf ./dist");
  assertAllowed("npx biome check .");
  assertAllowed("node --test src/**/__test__/*.test.ts");
  assertAllowed(`cat ${join(PROJECT, ".tlc/harness/lessons.md")}`);
  assertAllowed("python3 -c \"print('hello')\"");
});

test("a quoted redirect is data, not a redirect", () => {
  // hazard: found by this rule denying the command that verified it. A JSON hook payload carrying
  // `"command":"echo x > cfg"` is one quoted argument; scanning inside it invents a redirect that no shell
  // would perform. Only the opening quote matters, so `>"$f"` stays a real redirect.
  assertAllowed(`printf '%s' '{"command":"echo x > ${CONFIG}"}' > /tmp/payload.json`);
  assertAllowed(`echo '{"cmd":"tee ${CONFIG}"}' > /tmp/payload.json`);
  assertDenied(`echo x > "${CONFIG}"`);
  assertDenied(`echo x >"${join(PROJECT, CONFIG)}"`);
});

test("the runtime policy surface is guarded too, not just the project's", () => {
  // hazard: `loadPolicy` merges the runtime config *under* the project one, so any field the project does not
  // set is decided there, for every repository on the machine. Guarding only project-relative paths left this
  // allowed — and a reader head verb reached it, because the redirect target resolved outside the project.
  // why: derived from runtimeHome(), not from homedir(). CI sets TLC_HOME to the workspace, so a path built
  // from the home directory is not the runtime surface there and the assertions would pass locally while
  // proving nothing on the runners.
  const runtimeConfig = join(runtimeHome(), "config.json");
  assertDenied(`echo '{}' > ${runtimeConfig}`);
  assertDenied(`printf '{}' >> ${runtimeConfig}`);
  assertDenied(`cat /tmp/x > ${runtimeConfig}`);
  assertDenied(`tee ${runtimeConfig}`);
  assertDenied(`echo x > ${join(runtimeStateDir(), "flags/skip-verify")}`);
  assertAllowed(`cat ${runtimeConfig}`);
  assertAllowed(`grep mode ${runtimeConfig}`);
});

test("a proven reader may read another project's policy file", () => {
  assertAllowed("cat /other/repo/.tlc/harness/config.json");
});

test("a non-reader naming any harness policy path is denied, even one outside this project", () => {
  // why: prove-safe. Once the verb is not a proven reader, the gate has no way to establish that the path
  // in the string belongs to another repository rather than this one, so it refuses instead of guessing.
  assertDenied("python3 -c x /other/repo/.tlc/harness/config.json");
});

test("the mutating harness CLI is denied from inside the session", () => {
  assertDenied("tlc harness pause");
  assertDenied("tlc harness resume");
  assertDenied("tlc harness reset");
  assertDenied("tlc harness grind off");
  assertDenied("tlc harness mode solo");
  assertDenied("tlc harness init --minimal");
  assertDenied("tlc harness gate test-command node --test");
  assertDenied("env tlc harness grind off");
  assertDenied("/usr/local/bin/tlc harness mode solo");
  assertDenied("tlc harness --json pause");
});

test("the read-only harness CLI is allowed", () => {
  assertAllowed("tlc harness status");
  assertAllowed("tlc harness");
  assertAllowed("tlc harness help concepts");
  assertAllowed("tlc harness obs live");
  assertAllowed("tlc harness prices lookup x");
  assertAllowed("tlc harness lessons list");
  assertAllowed("tlc harness test");
});

test("one denying segment denies the whole command", () => {
  assertDenied(`ls; sed -i s/a/b/ ${CONFIG}`);
  assertDenied(`cat ${CONFIG} | tee ${CONFIG}`);
  assertAllowed(`cat ${CONFIG}; git status`);
});

test("a heredoc fed to an interpreter is a program", () => {
  assertDenied(`python3 - <<'PY'\nopen('${CONFIG}','w')\nPY`);
  assertDenied(`bash <<'SH'\necho x > ${CONFIG}\nSH`);
  assertDenied(`perl <<'PL'\nopen(F,">${CONFIG}")\nPL`);
});

test("a heredoc fed to something that does not execute it is a document", () => {
  // hazard: the first version of this rule denied "anything not a proven reader", which blocked
  // `git commit -F -` for a message that merely named the path — writing about the rule tripped it. Every
  // commit in this feature would have had to route around the gate it was adding.
  assertAllowed(`git commit -F - <<'EOF'\nfix: stop writing ${CONFIG} by hand\nEOF`);
  assertAllowed(`cat <<'EOF'\nsee ${CONFIG} for the gate commands\nEOF`);
  assertAllowed(`gh pr create --body-file - <<'EOF'\ntouches ${CONFIG}\nEOF`);
});

test("a heredoc belongs to the verb before its marker, not to the whole command", () => {
  // hazard: this exact command was denied while writing this feature's own tests — the body goes to `cat`,
  // and `node` is a separate command that never sees it.
  assertAllowed(`cat >> src/x.test.ts <<'T'\nassert(${CONFIG})\nT\nnode --test 'src/**/*.test.ts'`);
  assertDenied(`cat /tmp/a; python3 - <<'PY'\nopen('${CONFIG}','w')\nPY`);
});

test("a heredoc that writes the surface is still caught by the path rules", () => {
  // why: dropping the interpreter check for documents does not open the write route — the redirect and
  // path-argument rules see the target without ever reading the body.
  assertDenied(`cat > ${CONFIG} <<'EOF'\n{}\nEOF`);
  assertDenied(`tee ${CONFIG} <<'EOF'\n{}\nEOF`);
});

test("the floor denies through evaluateFloor with the rule named", () => {
  const decision = evaluateFloor({
    projectDir: PROJECT,
    command: `python3 -c "import json; json.dump({}, open('${CONFIG}','w'))"`,
  });
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.match(decision.reason, /rule=policy-surface-write/);
    // invariant: it carries the same shape as every other floor rule, including the line stating that no
    // config switch exists, and it never names a policy field the agent could be tempted to go set.
    assert.match(decision.reason, /it has no config switch/);
    assert.doesNotMatch(decision.reason, /grind\.|shipGate|policy\.json/);
  }
});

/**
 * hazard: every policy-surface refusal used to end with the same sentence — set a gate command, make policy changes
 * from your own terminal. An agent trying to *read* the handoff the harness had just told it to read got advice
 * about *writing* policy, and could not plan around it ([/decisions/ad-047.md](/decisions/ad-047.md)).
 */
test("a refusal on an unproven reader says how to read, not how to change policy", () => {
  const decision = evaluateFloor({
    projectDir: PROJECT,
    command: `python3 -c "print(open('${CONFIG}').read())"`,
  });
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.match(decision.reason, /Reading is allowed/);
    assert.match(decision.reason, /tlc harness handoff/);
    assert.doesNotMatch(decision.reason, /tlc harness gate test-command/);
    assert.doesNotMatch(decision.reason, /your own terminal/);
  }
});

// invariant: a write refusal keeps naming who may write. The remedy comes from the branch that denied, so the two
// cases cannot collapse back into one tail.
test("a refusal on a mutating command still names the operator's route", () => {
  const decision = evaluateFloor({ projectDir: PROJECT, command: "tlc harness pause" });
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.match(decision.reason, /your own terminal/);
    assert.doesNotMatch(decision.reason, /Reading is allowed/);
  }
});

/**
 * hazard: `test` and `[` were missing from the proven readers, so the obvious way to read the handoff —
 * `test -f handoff.json && head -c 2000 handoff.json` — was refused. They evaluate a predicate and produce an exit
 * code; neither can write a file, which makes them strictly safer than `echo`, already on the list.
 */
test("test and [ are proven readers, so guarding a read before it is allowed", () => {
  assertAllowed(`test -f ${HANDOFF} && head -c 2000 ${HANDOFF}`);
  assertAllowed(`[ -f ${HANDOFF} ] && cat ${HANDOFF}`);
  assertAllowed(`test -s ${CONFIG}`);
});

// invariant: allowlisting the verb does not allowlist a redirect. `test` cannot write on its own, and the redirect
// rules are what stop it being used as a carrier.
test("a redirect onto the surface is still denied even with an allowed verb", () => {
  assertDenied(`test -f ${HANDOFF} > ${CONFIG}`);
});

test("the floor still allows the reads the bootstrap asks for", () => {
  assert.equal(evaluateFloor({ projectDir: PROJECT, command: `cat ${HANDOFF}` }).kind, "allow");
  assert.equal(evaluateFloor({ projectDir: PROJECT, command: `grep -n mode ${CONFIG}` }).kind, "allow");
});

// invariant: lock 1 of four. `tlc harness policy accept` exists to clear a tampering signal, so an agent able to
// reach it would make the whole integrity rail decorative. It is refused by a floor rule with no config switch
// ([/decisions/ad-030.md](/decisions/ad-030.md)).
test("the command that clears a policy divergence is refused from inside a session", () => {
  assertDenied(`tlc harness policy accept ${CONFIG}`);
  assertDenied("tlc harness policy");
  assertDenied("/usr/local/bin/tlc harness policy accept x");
});
