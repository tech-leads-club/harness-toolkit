import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSatisfiesContract } from "../../src/providers/__test__/provider.contract.test.ts";
import type { ProviderPort } from "../../src/providers/provider.port.ts";
import { scaffold } from "../new-provider.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// why: distinctive and unlikely to collide with a real provider name — the same throwaway
// convention T5's own tests use.
const THROWAWAY_NAME = "scaffoldcontractzz";

function cleanup(): void {
  rmSync(join(repoRoot, "src", "providers", THROWAWAY_NAME), { recursive: true, force: true });
  rmSync(join(repoRoot, "docs", "providers", `${THROWAWAY_NAME}.md`), { force: true });
}

test("a freshly-scaffolded stub fails assertSatisfiesContract with a named, specific error — not a crash", async () => {
  cleanup();
  try {
    const scaffolded = scaffold(THROWAWAY_NAME);
    assert.deepEqual(scaffolded, { ok: true });

    const indexPath = join(repoRoot, "src", "providers", THROWAWAY_NAME, "index.ts");
    const mod = (await import(pathToFileURL(indexPath).href)) as Record<string, ProviderPort>;
    const provider = mod[`${THROWAWAY_NAME}Provider`];
    assert.ok(provider, "expected the scaffold's assembled ProviderPort export");

    assert.throws(
      () => assertSatisfiesContract(provider),
      (error: unknown) =>
        error instanceof Error &&
        /toolOutputRewriteOn entries are valid HarnessEventKind values/.test(error.message),
      "expected a named, specific contract failure — not an unrelated crash",
    );
  } finally {
    cleanup();
  }
});
