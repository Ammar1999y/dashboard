export function getCacheControlHeader(params: {
  mimeType: string;
  isPublic: boolean;
}): string {
  const { mimeType, isPublic } = params;

  if (!isPublic) {
    return 'private, no-cache, no-store, must-revalidate';
  }

  if (mimeType.startsWith('image/')) {
    return 'public, max-age=31536000, immutable';
  }

  if (
    mimeType === 'application/pdf' ||
    mimeType.includes('document') ||
    mimeType.includes('word') ||
    mimeType.includes('excel') ||
    mimeType.includes('spreadsheet')
  ) {
    return 'public, max-age=3600';
  }

  return 'public, max-age=86400';
}

/** RFC 5987 encoding; `encodeURIComponent` leaves `'*()` unescaped. */
const ATTR_CHARS = new Set(
  [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$&+-.^_`|~',
  ].map((character) => character.codePointAt(0))
);

function encodeExtValue(filename: string): string {
  const bytes = new TextEncoder().encode(filename);
  let out = '';
  for (const byte of bytes)
    out += ATTR_CHARS.has(byte)
      ? String.fromCodePoint(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  return out;
}

/**
 * Keeps `filename` portable across SDK encodings; `filename*` carries the
 * original name. Controls, quotes, and backslashes are unsafe in this fallback.
 */
function asciiFallback(filename: string): string {
  let out = '';
  for (const character of filename) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || character === '\\' || code === 0x7f || code < 0x20)
      continue;
    out += code > 0x7f ? '_' : character;
  }
  return out || 'download';
}

/** Emits an ASCII fallback and the RFC 5987 filename. */
export function getContentDisposition(params: {
  filename: string;
  inline?: boolean;
}): string {
  const { filename, inline = false } = params;
  const disposition = inline ? 'inline' : 'attachment';

  return (
    `${disposition}; filename="${asciiFallback(filename)}"; ` +
    `filename*=UTF-8''${encodeExtValue(filename)}`
  );
}
