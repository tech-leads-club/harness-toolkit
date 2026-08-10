/**
 * The domain's own vocabulary for "how does this file write a comment". The scanner asks that question and gets
 * this answer; it knows nothing about extensions, languages or delimiters beyond what is in here.
 */
export type CommentSyntax = {
  /** Prefixes that start a comment running to end of line. */
  line: readonly string[];
  /** Open/close pairs. A pair whose open and close are equal is a symmetric fence, like a Python docstring. */
  block: readonly (readonly [string, string])[];
  /**
   * Prefixes a continuation line inside a block conventionally carries — `*` in the C family. Without it a
   * multi-line doc block reads as one comment followed by unrelated lines, and a marker on its first line stops
   * covering the rest of it.
   */
  middle: readonly string[];
};

export type CommentSyntaxEntry = CommentSyntax & {
  id: string;
  /** Extensions including the dot, or a bare filename for the ones that have none (`Dockerfile`, `Makefile`). */
  extensions: readonly string[];
};

export const NO_COMMENT_SYNTAX: CommentSyntax = { line: [], block: [], middle: [] };
