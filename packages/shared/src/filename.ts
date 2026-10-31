/** Whitespace the allow-list would delete, joining the words on either side. */
const SEPARATORS = /[\t\n\v\f\r\u{85}\p{Zl}\p{Zp}]/gu;

/**
 * `maxLength` counts CODE POINTS: a lone surrogate from a split pair makes
 * `encodeURIComponent` throw.
 *
 * Marks are kept because Arabic diacritics and Indic vowel signs are part of
 * the word; a default-ignorable code point is dropped even when it is a letter
 * or a mark, since it renders as nothing. NFC runs after the strip, which can
 * leave a base and its mark newly adjacent.
 */
export function sanitizeFilename(filename: string, maxLength = 50): string {
  if (!filename || typeof filename !== 'string') return 'unnamed';

  const lastDot = filename.lastIndexOf('.');
  const nameWithoutExt = lastDot > 0 ? filename.slice(0, lastDot) : filename;

  const cleaned = nameWithoutExt
    .replaceAll(SEPARATORS, ' ')
    .replaceAll(
      /[^\p{L}\p{M}\p{N}\p{Zs}_\-()]|\p{Default_Ignorable_Code_Point}/gu,
      ''
    )
    .normalize('NFC')
    .replaceAll(/\s+/g, ' ');

  const sanitized = [...cleaned].slice(0, maxLength).join('').trim();

  return sanitized || 'unnamed';
}
