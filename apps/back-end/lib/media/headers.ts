import type { BucketType, FileKind } from '@app/shared/validation/enums';

const PUBLIC_CACHE_CONTROL: Readonly<Record<FileKind, string>> = {
  image: 'public, max-age=31536000, immutable',
  document: 'public, max-age=3600',
};

const PRIVATE_CACHE_CONTROL = 'private, no-cache, no-store, must-revalidate';

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

export function objectHeaders(
  object: { mimeType: string; kind: FileKind; filename: string },
  bucketType: BucketType
) {
  return {
    contentType: object.mimeType,
    cacheControl:
      bucketType === 'public'
        ? PUBLIC_CACHE_CONTROL[object.kind]
        : PRIVATE_CACHE_CONTROL,
    // Documents are never rendered inline: a PDF on the public origin would
    // otherwise run its scripting on that origin. The one inline rendering is
    // `previewUrl` in `./files.ts`, overridden per link on the store's own
    // origin, which carries no cookies.
    contentDisposition: getContentDisposition({
      filename: object.filename,
      inline: object.kind === 'image',
    }),
  };
}
