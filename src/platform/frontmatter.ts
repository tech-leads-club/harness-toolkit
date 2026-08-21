/**
 * The one frontmatter reader.
 *
 * why here: there were two — a full parser in `tools/dev/check-docs-bundle.ts`, which never ships and which
 * `core/` may not import, and a private single-field extractor in `core/release/release.decisions.ts`. Operator
 * rules need a third caller, and a third copy is the duplication this product's own gate refuses. It sits in
 * `platform/` because it is a format primitive with no policy in it, and because that is the one direction all
 * three callers may import from ([/decisions/ad-100.md](/decisions/ad-100.md)).
 *
 * invariant: pure. No filesystem, no clock. The caller reads the file.
 */

export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

/** The shape `check-docs-bundle` already consumed, kept so moving this changed no caller's contract. */
export type ParseResult = { frontmatter: Frontmatter | null; error: string | null };

export type FrontmatterDoc = {
  fields: Frontmatter;
  /** Everything after the closing fence, verbatim. An operator rule's instruction lives here. */
  body: string;
};

function extractFrontmatterBlock(content: string): { block: string; bodyAt: number } | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return null;
  }
  const firstBreak = content.indexOf("\n");
  const rest = content.slice(firstBreak + 1);
  const closingMatch = /^---\s*$/m.exec(rest);
  if (!closingMatch) {
    return null;
  }
  return {
    block: rest.slice(0, closingMatch.index),
    bodyAt: firstBreak + 1 + closingMatch.index + closingMatch[0].length,
  };
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * hazard: an escaped quote inside a value survived the outer-quote strip and reached the operator as a literal
 * `\"` in their terminal. Seen in a real update run ([/decisions/ad-034.md](/decisions/ad-034.md)).
 */
function unescapeQuotes(value: string): string {
  return value.replace(/\\(["'\\])/g, "$1");
}

function parseValue(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") {
      return [];
    }
    return inner.split(",").map((item) => unescapeQuotes(stripQuotes(item)));
  }
  return unescapeQuotes(stripQuotes(trimmed));
}

/**
 * why block lists: a rule declares several proofs, and `require: [a, b]` on one line is not how anybody writes
 * three of them. `key:` with nothing after it opens a list; `key: value` closes any list before it.
 */
export function parseFrontmatterDoc(content: string): { doc: FrontmatterDoc | null; error: string | null } {
  const extracted = extractFrontmatterBlock(content);
  if (extracted === null) {
    return { doc: null, error: "missing --- frontmatter block" };
  }
  const fields: Frontmatter = {};
  let listKey: string | null = null;

  for (const line of extracted.block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("- ")) {
      if (listKey === null) {
        return { doc: null, error: `list item with no key above it: "${trimmed}"` };
      }
      const current = fields[listKey];
      const item = unescapeQuotes(stripQuotes(trimmed.slice(2)));
      fields[listKey] = Array.isArray(current) ? [...current, item] : [item];
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      return { doc: null, error: `unparseable frontmatter line: "${trimmed}"` };
    }
    const key = trimmed.slice(0, separator).trim();
    if (key === "") {
      return { doc: null, error: `frontmatter line has an empty key: "${trimmed}"` };
    }
    const value = trimmed.slice(separator + 1);
    if (value.trim() === "") {
      fields[key] = [];
      listKey = key;
      continue;
    }
    fields[key] = parseValue(value);
    listKey = null;
  }

  return { doc: { fields, body: content.slice(extracted.bodyAt).trim() }, error: null };
}

/** invariant: the shape the docs bundle check already used. One implementation, two entry points. */
export function parseFrontmatter(content: string): ParseResult {
  const { doc, error } = parseFrontmatterDoc(content);
  return doc === null ? { frontmatter: null, error } : { frontmatter: doc.fields, error: null };
}

/** why: one field, by name, for a caller that wants nothing else. */
export function frontmatterField(content: string, field: string): string | undefined {
  const { doc } = parseFrontmatterDoc(content);
  const value = doc?.fields[field];
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

/** why: every field a rule reads is one value or a list of them, and the caller should not care which. */
export function asList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).filter((item) => item !== "");
}
