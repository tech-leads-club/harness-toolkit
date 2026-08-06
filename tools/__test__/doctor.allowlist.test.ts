import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { projectConfigPath } from "../../src/platform/paths.ts";
import { checkSubagentAllowlist } from "../doctor.ts";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function projectWith(subagents: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-doctor-allow-"));
  cleanup.push(root);
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, subagents }));
  return root;
}

/**
 * hazard: `enforceAllowlist: true` with an empty list is a rail declared on and enforcing nothing. It used to deny
 * every spawn, which read as a bug and got the rail switched off; it now denies none, which is invisible unless
 * something says so ([/decisions/ad-053.md](/decisions/ad-053.md)).
 */
test("an enforced-but-empty allowlist is reported as a fault", () => {
  const checks = checkSubagentAllowlist(projectWith({ enforceAllowlist: true, allowedModels: [] }));
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.level, "fail");
  assert.match(checks[0]?.detail ?? "", /subagents\.allowedModels/);
  assert.match(checks[0]?.detail ?? "", /permits every model/);
  assert.match(checks[0]?.detail ?? "", /ships no list/);
});

test("an omitted allowlist under enforcement is the same fault", () => {
  const checks = checkSubagentAllowlist(projectWith({ enforceAllowlist: true }));
  assert.equal(checks.length, 1);
});

// invariant: a provider-keyed map counts its entries, or a project that scoped its list per provider reads as empty.
test("a provider-keyed list with entries is not a fault", () => {
  const root = projectWith({ enforceAllowlist: true, allowedModels: { cursor: ["composer-2.5"] } });
  assert.deepEqual(checkSubagentAllowlist(root), []);
});

test("a provider-keyed map with no entries at all is a fault", () => {
  const root = projectWith({ enforceAllowlist: true, allowedModels: { cursor: [] } });
  assert.equal(checkSubagentAllowlist(root).length, 1);
});

// invariant: silent when the rail is off. A row about a switched-off capability is noise on every healthy run
// ([/decisions/ad-034.md](/decisions/ad-034.md)).
test("nothing is reported when enforcement is off", () => {
  assert.deepEqual(checkSubagentAllowlist(projectWith({ enforceAllowlist: false, allowedModels: [] })), []);
});

// invariant: and silent when the list has entries, which is the healthy configuration.
test("nothing is reported when the list has entries", () => {
  const root = projectWith({ enforceAllowlist: true, allowedModels: ["claude-opus-5"] });
  assert.deepEqual(checkSubagentAllowlist(root), []);
});
