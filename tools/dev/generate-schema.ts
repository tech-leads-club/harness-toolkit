import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as TJS from "typescript-json-schema";

/**
 * why: `PartialPolicy`, not `Policy` — a human-written config is always partial, and `Policy`'s every
 * field being non-optional would mark a minimal config invalid in every editor.
 */
const ROOT_TYPE = "PartialPolicy";
const SOURCE_FILE = "src/core/policy/policy.types.ts";

function compilerOptionsFrom(root: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
  };
  return raw.compilerOptions;
}

/**
 * invariant: `noExtraProps` is what makes an unknown key (the `format` class of bug) a schema
 * violation instead of something the schema silently accepts.
 */
export function generateConfigSchema(root: string): Record<string, unknown> {
  const program = TJS.getProgramFromFiles([join(root, SOURCE_FILE)], compilerOptionsFrom(root), root);
  const schema = TJS.generateSchema(program, ROOT_TYPE, {
    required: true,
    noExtraProps: true,
    strictNullChecks: true,
  });
  if (schema === null) {
    throw new Error(`typescript-json-schema produced no schema for ${ROOT_TYPE} in ${SOURCE_FILE}`);
  }
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const withSchemaProp = {
    ...schema,
    properties: {
      // why: a JSON Schema meta-key, not a PartialPolicy field — typescript-json-schema never emits
      // it, and `noExtraProps` would otherwise make every real config with a `$schema` line invalid.
      $schema: { type: "string" },
      ...properties,
    },
  };
  return redactBuildPath(withSchemaProp, root);
}

/**
 * hazard: a field typed `Partial<Policy["grind"]>` (an indexed-access type, not its own named alias)
 * has no clean name to give its `$ref`, so the generator falls back to printing the full structural
 * type — including an `import("<absolute path>")` type query for every cross-file reference inside
 * it. That absolute path is the machine that ran the build, encoded twice: once raw in `$ref` targets
 * that are also definition keys, once URI-percent-encoded in the `$ref` string itself. Published
 * as-is, it would leak the CI runner's (or a contributor's) filesystem layout into a public schema.
 */
function redactBuildPath(schema: Record<string, unknown>, root: string): Record<string, unknown> {
  const serialized = JSON.stringify(schema).split(root).join(".").split(encodeURIComponent(root)).join(".");
  return JSON.parse(serialized) as Record<string, unknown>;
}
