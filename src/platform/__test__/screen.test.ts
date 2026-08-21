import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { render, type Screen, terminalColumns, wrapText } from "../screen.ts";
import { PLAIN } from "../style.ts";

/**
 * hazard: the lessons list cut its instruction at 160 characters with no marker, so a 263-character lesson lost
 * 103 of them mid-word and the reader could not tell it had happened. Wrapping is the fix that leaves nothing to
 * announce ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
describe("wrapText", () => {
  test("prose shorter than the width is one line, unchanged", () => {
    assert.deepEqual(wrapText("short enough", 40), ["short enough"]);
  });

  test("prose is broken at a word boundary, never mid-word", () => {
    const lines = wrapText("one two three four five six", 11);

    assert.deepEqual(lines, ["one two", "three four", "five six"]);
    for (const line of lines) {
      assert.ok(line.length <= 11, line);
    }
  });

  /** invariant: no character is lost. That is the whole point — a slice loses them silently. */
  test("every word survives the wrap", () => {
    const text = "search_skills before answering any task then read_skill the best match";

    assert.equal(wrapText(text, 20).join(" "), text);
  });

  /**
   * invariant: a word longer than the width stands on its own line rather than being cut. An overlong line is
   * visible; a missing character is not.
   */
  test("a word wider than the width is kept whole", () => {
    assert.deepEqual(wrapText("a supercalifragilistic b", 8), ["a", "supercalifragilistic", "b"]);
  });

  /**
   * hazard: the case above starts with a one-character word, so the branch that takes the *first* word of a line
   * was never exercised — cutting it there left the test green. An overlong word has to survive in both positions
   * ([/decisions/ad-101.md](/decisions/ad-101.md)).
   */
  test("an overlong first word is kept whole too", () => {
    assert.deepEqual(wrapText("supercalifragilistic tail", 8), ["supercalifragilistic", "tail"]);
  });

  test("an empty string stays one empty line", () => {
    assert.deepEqual(wrapText("", 40), [""]);
  });

  test("runs of whitespace collapse rather than producing empty lines", () => {
    assert.deepEqual(wrapText("one   two\n\nthree", 40), ["one two three"]);
  });
});

describe("terminalColumns", () => {
  test("a sensible terminal width is used as-is", () => {
    assert.equal(terminalColumns(90), 90);
  });

  /** why clamped: 400 columns produces lines nobody tracks across, and 8 produces a word per line. */
  test("an absurd width is clamped at both ends", () => {
    assert.equal(terminalColumns(400), 110);
    assert.equal(terminalColumns(8), 60);
  });

  test("no width at all — not a TTY — gets a fixed sensible one", () => {
    assert.equal(terminalColumns(undefined), 100);
  });
});

describe("render", () => {
  const prose = "one two three four five six seven eight nine ten";

  function screen(section: Screen["sections"][number]): Screen {
    return { title: "t", sections: [section] };
  }

  test("a section that opts into wrapping has its prose broken and indented", () => {
    const out = render(screen({ lines: [prose], wrap: true }), PLAIN, 22);
    const body = out.split("\n").filter((line) => line.startsWith("  ") && line.trim() !== "");

    assert.ok(body.length > 1, out);
    for (const line of body) {
      assert.ok(line.length <= 22, `${line.length}: ${line}`);
    }
    assert.equal(body.map((line) => line.trim()).join(" "), prose);
  });

  /**
   * invariant: a section's lines are sometimes a command to copy, and wrapping
   * `tlc harness policy accept <path>` across two lines makes it unpasteable. Default is unchanged.
   */
  test("a section that does not opt in is left exactly as it was", () => {
    const command = "tlc harness policy accept /a/very/long/path/to/a/config.json";
    const out = render(screen({ lines: [command] }), PLAIN, 22);

    assert.ok(out.includes(`  ${command}`), out);
  });

  test("a blank line stays blank rather than becoming an indent", () => {
    const out = render(screen({ lines: ["", "after"], wrap: true }), PLAIN, 40);

    assert.ok(out.includes("\n\n  after"), JSON.stringify(out));
  });

  test("rows are untouched by the wrap flag", () => {
    const out = render(screen({ rows: [{ label: "k", value: prose }], wrap: true }), PLAIN, 22);

    assert.ok(out.includes(prose), out);
  });
});
