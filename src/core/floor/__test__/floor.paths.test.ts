import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { isPolicySurface, isProtectedWiringTarget } from "../floor.paths.ts";

const PROJECT = "/home/dev/project";
const WIRING_TARGET = "/home/someone/.editor-x/settings.json";

test("isProtectedWiringTarget: an exact match on a protected path is true", () => {
  assert.equal(isProtectedWiringTarget(WIRING_TARGET, [WIRING_TARGET]), true);
});

test("isProtectedWiringTarget: a file inside a protected directory target is true", () => {
  const dirTarget = "/home/someone/.editor-y";
  assert.equal(isProtectedWiringTarget(join(dirTarget, "hooks.json"), [dirTarget]), true);
});

test("isProtectedWiringTarget: an unrelated path is false", () => {
  assert.equal(isProtectedWiringTarget("/home/someone/notes.txt", [WIRING_TARGET]), false);
});

test("isProtectedWiringTarget: a lookalike path that merely shares a prefix is false", () => {
  assert.equal(isProtectedWiringTarget(`${WIRING_TARGET}.bak`, [WIRING_TARGET]), false);
});

test("isProtectedWiringTarget: an empty protected-path list is always false", () => {
  assert.equal(isProtectedWiringTarget(WIRING_TARGET, []), false);
});

test("isPolicySurface: harness config/state surface is unchanged with no extraSurfacePaths argument", () => {
  assert.equal(isPolicySurface(PROJECT, join(PROJECT, ".tlc/harness/config.json")), true);
  assert.equal(isPolicySurface(PROJECT, join(PROJECT, "src/index.ts")), false);
});

test("isPolicySurface: a path in extraSurfacePaths is recognized as policy surface", () => {
  assert.equal(isPolicySurface(PROJECT, WIRING_TARGET, [WIRING_TARGET]), true);
});

test("isPolicySurface: a lookalike path that does not resolve to any listed path is not matched", () => {
  assert.equal(isPolicySurface(PROJECT, `${WIRING_TARGET}.bak`, [WIRING_TARGET]), false);
  assert.equal(isPolicySurface(PROJECT, "/home/someone/.editor-z/hooks.json", [WIRING_TARGET]), false);
});
