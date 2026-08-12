export const COLORS = {
  structure: "#3d3a4a",
  accent: "#a78bfa",
  success: "#6ee7b7",
  warning: "#d4a574",
  error: "#f87171",
  info: "#93c5fd",
  textMain: "#f5f5f7",
  textMuted: "#9ca3af",
  textDim: "#6b7280",
} as const;

export const SYMBOLS = {
  check: "✔",
  cross: "✖",
  warning: "⚠",
  arrow: "→",
  arrowRight: "▸",
  dot: "•",
  bar: "│",
  rule: "══",
  dash: "──",
} as const;

function rgb(hex: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) {
    return "255;255;255";
  }
  return [match[1], match[2], match[3]].map((part) => Number.parseInt(part as string, 16)).join(";");
}

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

export type ColorName = keyof typeof COLORS;

// hazard: the TTY check is load-bearing, not politeness. This CLI's output is redirected into files, quoted into
// gate follow-ups and read by the repository's own checkers, and an escape reaching any of those already sent an
// agent to fix `39msrc/…`, a file that does not exist.
export function colorEnabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  isTty: boolean = process.stdout.isTTY === true,
): boolean {
  if ("NO_COLOR" in env) {
    return false;
  }
  if (argv.includes("--no-color")) {
    return false;
  }
  return isTty;
}

export type Style = {
  paint: (name: ColorName, text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  heading: (text: string) => string;
  footer: (text: string) => string;
  enabled: boolean;
};

// why: truecolor written directly because this package has no runtime dependency and ships no binary
// ([/decisions/ad-012.md](/decisions/ad-012.md)).
export function createStyle(enabled = colorEnabled()): Style {
  const wrap = (code: string, text: string) => (enabled ? `${ESC}[${code}m${text}${RESET}` : text);
  const paint = (name: ColorName, text: string) => wrap(`38;2;${rgb(COLORS[name])}`, text);
  return {
    enabled,
    paint,
    bold: (text) => wrap("1", text),
    dim: (text) => paint("textDim", text),
    heading: (text) => paint("accent", `${SYMBOLS.rule} ${text} ${SYMBOLS.rule}`),
    footer: (text) => paint("textDim", `${SYMBOLS.dash} ${text} ${SYMBOLS.dash}`),
  };
}

export const PLAIN: Style = createStyle(false);
