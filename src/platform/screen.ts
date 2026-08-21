import { KV_WIDTH, type StatusLevel, type Style, SYMBOLS } from "./style.ts";

export type Row = { label: string; value: string; level?: StatusLevel };

/**
 * `wrap` marks a section's lines as prose, so they are broken at word boundaries to fit the terminal.
 *
 * why opt-in rather than always: a section's lines are sometimes a command to copy — wrapping
 * `tlc harness policy accept <path>` across two lines makes it unpasteable. Prose and payload look identical to a
 * renderer, so the caller says which it has ([/decisions/ad-101.md](/decisions/ad-101.md)).
 */
export type Section = { title?: string; rows?: Row[]; lines?: string[]; wrap?: boolean };

export type Screen = {
  title: string;
  summary?: string[];
  sections: Section[];
  footer?: string;
};

/** The two-space indent `render` puts in front of every line, which the wrap width has to leave room for. */
const INDENT = 2;

/**
 * why clamped: a 400-column terminal produces lines nobody tracks across, and an 8-column one produces a word per
 * line. Outside a TTY there is no width to read, and a fixed sensible one beats guessing.
 */
export function terminalColumns(columns: number | undefined = process.stdout.columns): number {
  return Math.min(110, Math.max(60, columns ?? 100));
}

/**
 * Break prose at word boundaries so nothing is hidden.
 *
 * hazard: the lessons list cut the instruction at 160 characters with no marker — a 263-character lesson lost 103
 * of them mid-word, and the reader could not tell. An operator asked why their lesson had been cut; it had not
 * been, only its display had ([/decisions/ad-101.md](/decisions/ad-101.md)).
 *
 * invariant: a word longer than the width stands on its own line rather than being cut. Losing a character is
 * worse than an overlong line, because only one of the two is visible.
 */
export function wrapText(text: string, width: number): string[] {
  if (text === "") {
    return [""];
  }
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    if (current === "") {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines.length === 0 ? [""] : lines;
}

// why: screens describe their content and never their paint, so spacing, colour and alignment are decided once.
// A new screen can only emit this shape, which is what makes "no screen outside the standard" mechanical.
export function render(screen: Screen, style: Style, columns = terminalColumns()): string {
  const out: string[] = [style.heading(screen.title.toUpperCase())];

  if (screen.summary && screen.summary.length > 0) {
    out.push(`   ${screen.summary.join(style.dim(` ${SYMBOLS.bar} `))}`);
  }

  const width = Math.max(
    KV_WIDTH,
    ...screen.sections.flatMap((section) => (section.rows ?? []).map((row) => row.label.length + 1)),
  );

  for (const section of screen.sections) {
    out.push("");
    if (section.title) {
      out.push(style.paint("accent", section.title));
    }
    for (const row of section.rows ?? []) {
      const value = row.level ? style.status(row.level, row.value) : row.value;
      out.push(style.kv(row.label, value, width));
    }
    for (const line of section.lines ?? []) {
      if (line === "") {
        out.push("");
        continue;
      }
      const parts = section.wrap ? wrapText(line, columns - INDENT) : [line];
      for (const part of parts) {
        out.push(`  ${part}`);
      }
    }
  }

  if (screen.footer) {
    out.push("", style.footer(screen.footer));
  }
  return out.join("\n");
}
