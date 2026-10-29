/**
 * Text as search compares it: «أحمد» is «احمد», «مدرسة» is «مدرسه», «مُحَمَّد»
 * and «مـحـمـد» are «محمد», «١٢٣» is «123», «Café» is «Cafe». It loses
 * information, so its output is never shown.
 *
 * ⚠️ `search_fold` in `apps/back-end/db/migrations/004_search_fold_function.sql`
 * is this function in SQL, and the trigram indexes are built on it. The database
 * folds both sides of a search itself; this one measures a term before it is
 * sent and matches text in memory, so the two must agree wherever their Unicode
 * versions do (`tests/integration/search-fold.test.ts` in the back end).
 * Changing either means a new SQL function with its own indexes, shipped with
 * this file; the migration says how.
 *
 * Case is not folded: `ILIKE` does that, and `lower()` in SQL follows the
 * database's ctype, which would make the two sides disagree.
 */

const LETTERS: ReadonlyArray<readonly [string, string]> = [
  ['آ', 'ا'],
  ['أ', 'ا'],
  ['إ', 'ا'],
  ['ٱ', 'ا'],
  ['ؤ', 'و'],
  ['ئ', 'ي'],
  ['ى', 'ي'],
  ['ة', 'ه'],
  // Persian forms that arrive in pasted text.
  ['ک', 'ك'],
  ['ڪ', 'ك'],
  ['ی', 'ي'],
  ['ۀ', 'ه'],
];

const ARABIC_INDIC_ZERO = 0x06_60;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06_f0;

const FOLDED: ReadonlyMap<string, string> = new Map([
  ...LETTERS,
  ...[ARABIC_INDIC_ZERO, EXTENDED_ARABIC_INDIC_ZERO].flatMap((zero) =>
    Array.from(
      { length: 10 },
      (_, digit) => [String.fromCodePoint(zero + digit), String(digit)] as const
    )
  ),
]);

/**
 * Tashkeel, Quranic marks, tatweel, the Latin combining diacritics, and the
 * invisible formatting characters pasted text carries (soft hyphen, zero-width,
 * bidi controls). Named range by range because PostgreSQL's regex has no
 * Unicode property classes; the SQL side lists the same ranges.
 */
const MARKS =
  // eslint-disable-next-line security/detect-unsafe-regex -- one quantified class with nothing nested, so nothing to backtrack into; the rule counts each code-point escape as a repetition
  /[\u{AD}\u{300}-\u{36F}\u{610}-\u{61A}\u{61C}\u{640}\u{64B}-\u{65F}\u{670}\u{6D6}-\u{6ED}\u{898}-\u{89F}\u{8CA}-\u{8FF}\u{1AB0}-\u{1AFF}\u{1DC0}-\u{1DFF}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{20D0}-\u{20FF}\u{FE20}-\u{FE2F}\u{FEFF}]+/gu;

/** Every white-space character NFKC leaves as itself; the rest become U+0020. */
const WHITESPACE = /[\t-\r \u{85}\u{1680}\u{2028}\u{2029}]+/gu;

export function searchFold(text: string): string {
  // Between the two normalizations: NFKC turns presentation forms such as «ﺃ»
  // into the letters the map holds, and NFD would split «ۀ» into «ە» and a
  // hamza.
  let folded = '';
  for (const character of text.normalize('NFKC'))
    folded += FOLDED.get(character) ?? character;
  return folded
    .normalize('NFD')
    .replaceAll(MARKS, '')
    .replaceAll(WHITESPACE, ' ')
    .trim();
}

/**
 * What `ILIKE` compares on a folded text, for matching in memory. Lowered one
 * code point at a time, as PostgreSQL lowers: a whole-string `toLowerCase`
 * spells a final «Σ» as «ς», so «ΑΟΣ» would miss «ΑΟΣΑ».
 */
export function searchKey(text: string): string {
  let key = '';
  for (const character of searchFold(text)) key += character.toLowerCase();
  return key;
}
