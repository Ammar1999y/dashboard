/**
 * `maxLength` counts CODE POINTS: a lone surrogate from a split pair makes
 * `encodeURIComponent` throw.
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
