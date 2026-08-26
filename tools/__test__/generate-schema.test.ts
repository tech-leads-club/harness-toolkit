import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateConfigSchema } from "../../bin/generate-schema.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolveRef(schema: Record<string, unknown>, ref: string): Record<string, unknown> {
  const key = decodeURIComponent(ref.replace("#/definitions/", ""));
  const definitions = schema.definitions as Record<string, Record<string, unknown>>;
  const resolved = definitions[key];
  assert.ok(resolved, `no definition for ${key}`);
  return resolved;
}

test("the root rejects a key PartialPolicy does not declare — the format bug's exact shape", () => {
  const schema = generateConfigSchema(repoRoot);
  assert.equal(schema.additionalProperties, false);
  const properties = schema.properties as Record<string, unknown>;
  assert.equal("format" in properties, false);
  assert.equal("mode" in properties, true, "a real key must still be present");
});

test("a nested object also rejects an unknown key", () => {
  const schema = generateConfigSchema(repoRoot);
  const properties = schema.properties as Record<string, unknown>;
  const grind = properties.grind as { $ref?: string } & Record<string, unknown>;
  const grindDef = grind.$ref ? resolveRef(schema, grind.$ref) : grind;
  assert.equal(grindDef.additionalProperties, false);
  assert.deepEqual(Object.keys(grindDef.properties as object).sort(), [
    "appendFiles",
    "enabled",
    "lintCommand",
    "maxLoops",
    "testCommand",
  ]);
});

test("$schema is explicitly allowed at the root, though PartialPolicy never declares it", () => {
  const schema = generateConfigSchema(repoRoot);
  const properties = schema.properties as Record<string, unknown>;
  assert.deepEqual(properties.$schema, { type: "string" });
});

test("a field's why:/hazard:/invariant: JSDoc becomes its schema description", () => {
  const schema = generateConfigSchema(repoRoot);
  const duplication = (schema.properties as Record<string, unknown>).duplication as Record<string, unknown>;
  const minRun = (duplication.properties as Record<string, { description?: string }>).minRun;
  assert.match(minRun?.description ?? "", /why: the window is the only knob/);
});

// hazard: a field typed `Partial<Policy["grind"]>` has no clean alias, so the generator falls back
// to printing the full structural type — including an `import("<absolute path>")` for every
// cross-file reference. Unredacted, that leaks the build machine's filesystem layout into a
// published schema.
test("no build-machine absolute path survives into the generated schema", () => {
  const schema = generateConfigSchema(repoRoot);
  const serialized = JSON.stringify(schema);
  assert.equal(serialized.includes(repoRoot), false);
  assert.equal(serialized.includes(encodeURIComponent(repoRoot)), false);
});

// why: TypeScript prints its import() type queries against a canonicalised path, so a caller passing
// an equivalent but differently-spelled root (a trailing "." segment here) used to defeat the redaction
// entirely — the literal string it split on was never the string that got printed.
test("a root spelled with a trailing . segment is still redacted", () => {
  // why: path.join already normalises away a "." segment — join(repoRoot, ".") === repoRoot, so it
  // cannot exercise the case this test names. A template string is what keeps the segment intact.
  const unresolvedRoot = `${repoRoot}/.`;
  const schema = generateConfigSchema(unresolvedRoot);
  const serialized = JSON.stringify(schema);
  assert.equal(serialized.includes(repoRoot), false);
  assert.equal(serialized.includes(unresolvedRoot), false);
});
