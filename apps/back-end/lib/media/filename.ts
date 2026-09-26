/**
 * A display-safe name: the extension removed, `..` and every character outside
 * the allowlist stripped, whitespace collapsed.
 *
 * `maxLength` counts CODE POINTS, so the cut never splits a surrogate pair into
 * a lone surrogate, which `encodeURIComponent` throws on; the trim runs after
 * the cut, so the cut cannot leave a trailing space.
 */
export function sanitizeFilename(filename: string, maxLength = 50): string {
  if (!filename || typeof filename !== 'string') return 'unnamed';

  const lastDot = filename.lastIndexOf('.');
  const nameWithoutExt = lastDot > 0 ? filename.slice(0, lastDot) : filename;

  const cleaned = nameWithoutExt
    .replaceAll('..', '')
    .replaceAll(/[^\p{L}\p{N}\p{Zs}_\-()]/gu, '')
    .replaceAll(/\s+/g, ' ');

  const sanitized = [...cleaned].slice(0, maxLength).join('').trim();

  return sanitized || 'unnamed';
}
