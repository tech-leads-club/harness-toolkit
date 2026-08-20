import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { linkHealth, linkHealthMessage, SKILL_NAME, skillLinks } from "../skill.link.ts";

const HOME = "/opt/tlc/harness";

describe("skillLinks", () => {
  /**
   * hazard: `tlc harness update` linked to `<runtime-home>/../skills/harness-init` — a directory no provider
   * reads, and which did not exist at all on the machine where this was found. the installer had it right: each
   * provider reads only its own skills directory.
   */
  test("AC every present provider directory gets its own link, under that provider", () => {
    const links = skillLinks(HOME, ["/cfg/editor-a", "/cfg/editor-b"], () => true);

    assert.deepEqual(
      links.map((link) => link.target),
      [`/cfg/editor-a/skills/${SKILL_NAME}`, `/cfg/editor-b/skills/${SKILL_NAME}`],
    );
  });

  test("AC every link points at the skill inside the runtime home", () => {
    for (const link of skillLinks(HOME, ["/cfg/editor-a", "/cfg/editor-b"], () => true)) {
      assert.equal(link.source, `${HOME}/skills/${SKILL_NAME}`);
    }
  });

  /** invariant: a provider that is not installed gets nothing — linking into a directory nobody created is litter. */
  test("a provider directory that does not exist is skipped", () => {
    const links = skillLinks(HOME, ["/cfg/editor-a", "/cfg/editor-b"], (path) => path === "/cfg/editor-a");

    assert.equal(links.length, 1);
    assert.equal(links[0]?.providerDir, "/cfg/editor-a");
  });

  test("no provider installed yields no links rather than an error", () => {
    assert.deepEqual(
      skillLinks(HOME, ["/cfg/editor-a"], () => false),
      [],
    );
  });

  /** why: a relocated config directory is the supported case, and this repository is installed under one. */
  test("a relocated provider directory is linked where it actually is", () => {
    const links = skillLinks(HOME, ["/somewhere/else/relocated-config"], () => true);

    assert.equal(links[0]?.target, `/somewhere/else/relocated-config/skills/${SKILL_NAME}`);
  });
});

describe("linkHealth", () => {
  const probe = (resolved: string | null, exists = true) => ({
    linkTarget: () => resolved,
    exists: () => exists,
  });

  test("a link into the runtime home is ok", () => {
    const health = linkHealth("/cfg/skills/x", HOME, probe(`${HOME}/skills/${SKILL_NAME}`));

    assert.equal(health.state, "ok");
    assert.match(linkHealthMessage(health), /linked →/);
  });

  /**
   * hazard: this is the one found on a real machine —
   * `/tmp/tlc-recovery-…/install/skills/harness-init`, from a recovery run, gone on the next boot. Nothing in the
   * harness could see it, and a provider whose skill link dangles never routes to the init skill at all.
   */
  test("AC a link whose destination is gone is reported, with the remedy", () => {
    const health = linkHealth("/cfg/skills/x", HOME, probe("/tmp/tlc-recovery-abc/install/skills/x", false));

    assert.equal(health.state, "dangling");
    assert.match(linkHealthMessage(health), /does not exist/);
    assert.match(linkHealthMessage(health), /tlc harness install/);
  });

  /** invariant: reported even while it works, because a source outside the runtime is a source that will move. */
  test("AC a link that resolves outside the runtime is reported even when it exists", () => {
    const health = linkHealth("/cfg/skills/x", HOME, probe("/home/someone/repos/checkout/skills/x", true));

    assert.equal(health.state, "outside-runtime");
    assert.match(linkHealthMessage(health), /outside the runtime/);
  });

  test("no link at all is its own state, not a dangling one", () => {
    const health = linkHealth("/cfg/skills/x", HOME, probe(null));

    assert.equal(health.state, "absent");
    assert.match(linkHealthMessage(health), /not linked/);
  });

  /** invariant: a trailing separator on the runtime home must not turn a healthy link into a foreign one. */
  test("a trailing slash on the runtime home does not change the verdict", () => {
    assert.equal(linkHealth("/x", `${HOME}/`, probe(`${HOME}/skills/${SKILL_NAME}`)).state, "ok");
  });

  /** invariant: a sibling directory whose name merely starts with the home is not inside it. */
  test("a path that only shares a prefix with the runtime home is outside it", () => {
    assert.equal(linkHealth("/x", HOME, probe(`${HOME}-old/skills/${SKILL_NAME}`)).state, "outside-runtime");
  });

  test("the runtime home itself counts as inside", () => {
    assert.equal(linkHealth("/x", HOME, probe(HOME)).state, "ok");
  });

  /**
   * hazard: this is the false positive the first version shipped. On a contributor install the runtime home is a
   * symlink to a working clone — `doctor` reports that as healthy — so the link's realpath and the home as
   * configured never share a prefix, and two failures printed on a machine where nothing was wrong. AD-034: a
   * warning that fires on a healthy install is not a warning.
   */
  test("AC a runtime home that is itself a link is resolved before comparing", () => {
    const clone = "/somewhere/checkout";
    const health = linkHealth("/cfg/skills/x", HOME, {
      linkTarget: () => `${clone}/skills/${SKILL_NAME}`,
      exists: () => true,
      realpath: (path) => (path === HOME ? clone : path),
    });

    assert.equal(health.state, "ok");
  });

  /** invariant: resolving the home must not turn a genuinely foreign link into a healthy one. */
  test("AC a foreign link is still foreign once the home is resolved", () => {
    const health = linkHealth("/cfg/skills/x", HOME, {
      linkTarget: () => "/tmp/tlc-recovery-abc/install/skills/x",
      exists: () => true,
      realpath: (path) => (path === HOME ? "/somewhere/checkout" : path),
    });

    assert.equal(health.state, "outside-runtime");
  });

  /** why: without a resolver the comparison is textual, which is what every caller before doctor relied on. */
  test("with no resolver the home is compared as given", () => {
    assert.equal(linkHealth("/x", HOME, probe(`${HOME}/skills/${SKILL_NAME}`)).state, "ok");
  });
});
