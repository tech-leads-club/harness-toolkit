import { COMMENT_SYNTAX } from "./comment-syntax.catalog.ts";
import type { CommentSyntax, CommentSyntaxEntry } from "./comment-syntax.types.ts";

/**
 * why: the layer between the catalog's shape and the question the scanner asks. Everything the scanner knows
 * about languages arrives through `syntaxFor`, so the table can grow, be reordered or be regenerated from an
 * upstream language-configuration set without the scanner changing
 * ([/decisions/ad-058.md](/decisions/ad-058.md)).
 */
export function buildIndex(entries: readonly CommentSyntaxEntry[]): Map<string, CommentSyntax> {
  const byKey = new Map<string, CommentSyntax>();
  for (const entry of entries) {
    const syntax: CommentSyntax = { line: entry.line, block: entry.block, middle: entry.middle };
    for (const extension of entry.extensions) {
      byKey.set(extension.toLowerCase(), syntax);
    }
  }
  return byKey;
}

const INDEX = buildIndex(COMMENT_SYNTAX);

/**
 * invariant: the longest matching extension wins, so a two-part extension cannot be shadowed by its own tail. A
 * name with no dot is matched by the whole name, which is how `Dockerfile` and `Makefile` are reached.
 *
 * invariant: an unknown extension returns `null`, never a guess. Assuming a delimiter for an unrecognised
 * language is how `#` came to mean "comment" in TypeScript, where it starts a private field.
 */
export function lookupSyntax(file: string, index = INDEX): CommentSyntax | null {
  const lower = file.toLowerCase().replace(/\\/g, "/");
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const direct = index.get(name);
  if (direct) {
    return direct;
  }
  let best: CommentSyntax | null = null;
  let bestLength = 0;
  for (const [extension, syntax] of index) {
    if (extension.startsWith(".") && name.endsWith(extension) && extension.length > bestLength) {
      best = syntax;
      bestLength = extension.length;
    }
  }
  return best;
}

export function syntaxFor(file: string): CommentSyntax | null {
  return lookupSyntax(file);
}

// why: an image, a font, a lockfile or a test snapshot was never a candidate for a catalog entry — it carries
// no comment syntax to add. Reporting it as a coverage gap turns the signal an operator can act on into noise
// they learn to ignore.
const NOT_A_LANGUAGE =
  /\.(png|jpe?g|gif|ico|bmp|webp|svg|woff2?|ttf|eot|otf|pdf|zip|gz|tgz|tar|lockb|snap)$/i;

/** why: the operator needs the coverage gap named. A language nobody listed is a rail that silently passes. */
export function unknownExtensions(files: readonly string[]): string[] {
  const unknown = new Set<string>();
  for (const file of files) {
    if (NOT_A_LANGUAGE.test(file)) {
      continue;
    }
    if (lookupSyntax(file) === null) {
      const name = file.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? file;
      const dot = name.lastIndexOf(".");
      unknown.add(dot > 0 ? name.slice(dot) : name);
    }
  }
  return [...unknown].sort();
}

export const KNOWN_EXTENSION_COUNT = INDEX.size;
