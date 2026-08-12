import { KV_WIDTH, type StatusLevel, type Style, SYMBOLS } from "./style.ts";

export type Row = { label: string; value: string; level?: StatusLevel };

export type Section = { title?: string; rows?: Row[]; lines?: string[] };

export type Screen = {
  title: string;
  summary?: string[];
  sections: Section[];
  footer?: string;
};

// why: screens describe their content and never their paint, so spacing, colour and alignment are decided once.
// A new screen can only emit this shape, which is what makes "no screen outside the standard" mechanical.
export function render(screen: Screen, style: Style): string {
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
      out.push(line === "" ? "" : `  ${line}`);
    }
  }

  if (screen.footer) {
    out.push("", style.footer(screen.footer));
  }
  return out.join("\n");
}
