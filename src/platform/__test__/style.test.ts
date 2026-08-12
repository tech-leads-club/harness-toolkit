import assert from "node:assert/strict";
import { test } from "node:test";
import { colorEnabled, createStyle, PLAIN } from "../style.ts";

const ESC = String.fromCharCode(27);

test("colour is off unless stdout is a terminal", () => {
  assert.equal(colorEnabled({}, [], true), true);
  assert.equal(colorEnabled({}, [], false), false);
});

// hazard: an escape reaching output a machine parses is a defect. This CLI's output is redirected into files,
// quoted into gate follow-ups and read by the repository's own checkers.
test("NO_COLOR and --no-color each win over a terminal", () => {
  assert.equal(colorEnabled({ NO_COLOR: "" }, [], true), false);
  assert.equal(colorEnabled({ NO_COLOR: "1" }, [], true), false);
  assert.equal(colorEnabled({}, ["--no-color"], true), false);
});

test("a disabled style is the identity, byte for byte", () => {
  for (const rendered of [
    PLAIN.bold("x"),
    PLAIN.dim("x"),
    PLAIN.paint("error", "x"),
    PLAIN.heading("x"),
    PLAIN.footer("x"),
  ]) {
    assert.equal(rendered.includes(ESC), false, rendered);
  }
  assert.equal(PLAIN.paint("error", "x"), "x");
});

test("an enabled style emits truecolor and always resets", () => {
  const style = createStyle(true);
  const painted = style.paint("error", "boom");
  assert.match(painted, /\[38;2;248;113;113m/);
  assert.ok(painted.endsWith(`${ESC}[0m`));
  assert.match(style.heading("T"), /══ T ══/);
});

test("an unparseable hex degrades to white rather than emitting a broken escape", () => {
  const style = createStyle(true);
  assert.doesNotThrow(() => style.paint("accent", "x"));
  assert.match(style.paint("accent", "x"), /\[38;2;\d+;\d+;\d+m/);
});
