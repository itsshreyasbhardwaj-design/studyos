/**
 * Safe construction of FTS5 MATCH expressions from user input.
 *
 * FTS5's query language is not a search box. Passing raw input through is
 * both a crash and a leak: `C++` and `what?` are syntax errors, a stray `"`
 * is an unterminated string, `foo:` reports "no such column: foo", and a bare
 * `AND` or `*` fails outright. `NEAR` is worse — it parses as an operator, so
 * someone searching for those letters silently gets nothing.
 *
 * Search is the one field where users type whatever they like, so input is
 * tokenised and requoted rather than escaped. Tokens are split the same way
 * the unicode61 tokeniser splits the indexed text, so what matches is what
 * the index actually holds.
 */

const WORD = /[\p{L}\p{N}_]+/gu;

/**
 * Returns a MATCH expression, or undefined when the input holds no searchable
 * token at all (empty, whitespace, or pure punctuation) — the caller should
 * treat that as "no query" rather than "no results".
 */
export function ftsQuery(raw: string): string | undefined {
  const tokens = raw.toLowerCase().match(WORD);
  if (!tokens) return undefined;

  const phrases = tokens.map((t) => `"${t}"`);
  // Prefix-match the final token so results narrow while the user is typing —
  // but not a single character, which would prefix-match most of the corpus
  // and return noise ranked as if it were relevant. `C++` tokenises to `c`,
  // and the right answer there is the notes containing that word, not every
  // note containing a word starting with it.
  const last = tokens[tokens.length - 1];
  if (last.length > 1) phrases[phrases.length - 1] = `"${last}"*`;
  return phrases.join(' AND ');
}
