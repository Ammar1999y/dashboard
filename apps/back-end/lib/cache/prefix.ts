/**
 * Exclusive upper bound for a prefix range scan: the prefix's lexicographic
 * SUCCESSOR. No appended character can be correct, because the bound is
 * exclusive and a key can contain that character and continue past it.
 *
 * Incrementing the last code point is correct because the column collates
 * BINARY and UTF-8 preserves code point order bytewise. Surrogates are skipped:
 * they are not scalar values and do not survive the round trip into UTF-8.
 *
 * Kept free of any driver import so a test can exercise it without opening a
 * database.
 */

const MAX_CODE_POINT = 0x10_ff_ff;
const SURROGATE_START = 0xd8_00;
const SURROGATE_END = 0xdf_ff;

/**
 * `null` when every code point is already the maximum: then every key
 * `>= prefix` starts with the prefix, and the caller drops the upper bound.
 */
export function prefixUpperBound(prefix: string): string | null {
  // By code point, so a surrogate pair is the one character it represents.
  const points = [...prefix].map((char) => char.codePointAt(0) ?? 0);

  for (let i = points.length - 1; i >= 0; i--) {
    const current = points[i] ?? 0;
    if (current >= MAX_CODE_POINT) continue; // carry into the previous point

    let next = current + 1;
    if (next >= SURROGATE_START && next <= SURROGATE_END)
      next = SURROGATE_END + 1;

    return (
      points
        .slice(0, i)
        .map((point) => String.fromCodePoint(point))
        .join('') + String.fromCodePoint(next)
    );
  }

  return null;
}
