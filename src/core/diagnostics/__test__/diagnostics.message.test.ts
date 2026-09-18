import assert from "node:assert/strict";
import { test } from "node:test";
import { diffDiagnostic, rootDiagnostic, WHY_POINTER } from "../diagnostics.message.ts";

test("a diff diagnostic with no HEAD reports no HEAD and no reproduction line", () => {
  const diag = diffDiagnostic("/repo", null, [{ file: "a.ts" }]);
  assert.equal(diag.footer, `Checked /repo — no HEAD yet.\n${WHY_POINTER}`);
  assert.equal(diag.summary, "Checked /repo — no HEAD yet");
});

test("a diff diagnostic with zero files reports the head line and the pointer, no reproduction line", () => {
  const diag = diffDiagnostic("/repo", "abc123", []);
  assert.equal(diag.footer, `Checked /repo at abc123.\n${WHY_POINTER}`);
  assert.equal(diag.summary, "Checked /repo at abc123");
});

test("a diff diagnostic with one file reports one reproduction line in both footer and summary", () => {
  const diag = diffDiagnostic("/repo", "abc123", [{ file: "a.ts" }]);
  assert.equal(diag.footer, `Checked /repo at abc123.\nReproduce: git diff abc123 -- a.ts\n${WHY_POINTER}`);
  assert.equal(diag.summary, "Checked /repo at abc123 · Reproduce: git diff abc123 -- a.ts");
});

test("a diff diagnostic dedupes repeated files before listing reproduction lines", () => {
  const diag = diffDiagnostic("/repo", "abc123", [{ file: "a.ts" }, { file: "a.ts" }, { file: "b.ts" }]);
  const reproLines = diag.footer.split("\n").filter((line) => line.startsWith("Reproduce:"));
  assert.deepEqual(reproLines, ["Reproduce: git diff abc123 -- a.ts", "Reproduce: git diff abc123 -- b.ts"]);
});

test("a diff diagnostic caps reproduction lines at 5 distinct files", () => {
  const files = Array.from({ length: 7 }, (_, index) => ({ file: `f${index}.ts` }));
  const diag = diffDiagnostic("/repo", "abc123", files);
  const reproLines = diag.footer.split("\n").filter((line) => line.startsWith("Reproduce:"));
  assert.equal(reproLines.length, 5);
  assert.deepEqual(
    reproLines,
    files.slice(0, 5).map((f) => `Reproduce: git diff abc123 -- ${f.file}`),
  );
});

test("a root diagnostic names only the directory and the pointer, never a sha or a reproduction line", () => {
  const diag = rootDiagnostic("/repo");
  assert.equal(diag.footer, `Checked /repo.\n${WHY_POINTER}`);
  assert.equal(diag.summary, "Checked /repo");
  assert.equal(diag.footer.includes("Reproduce:"), false);
});
