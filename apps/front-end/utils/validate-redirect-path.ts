const ORIGIN = 'http://localhost';
const MAX_LENGTH = 2048;
const MAX_DECODE_PASSES = 5;
const PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const ENCODED_RUN = /(?:%[0-9A-Fa-f][0-9A-Fa-f])+/g;

// prettier-ignore
// eslint-disable-next-line security/detect-non-literal-regexp
const DANGEROUS_CHARACTERS = new RegExp([
  '[\u{0}-\u{1F}\u{7F}]',       // Control characters
  '[\u{AD}]',                     // Soft hyphen (invisible)
  '[\u{200B}-\u{200F}]',              // Zero-width chars
  '[\u{2028}-\u{202F}]',              // Line/paragraph separators, bidirectional
  '[\u{FEFF}]',                     // BOM
  '[\u{FF20}]',                     // Fullwidth @ (＠)
  '[\u{2215}\u{2044}\u{FF0F}\u{29F8}]',   // Unicode slashes (∕, ⁄, ／, ⧸)
].join('|'));

/** Decoded until stable, or `null` when it will not decode or never settles. */
function decodeStrict(value: string): string | null {
  let decoded = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return null;
}

/** Each run of escapes decoded where it can be; a literal `%` stays as written. */
function decodeLenient(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const next = decoded.replaceAll(ENCODED_RUN, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

/** A same-origin path to return to after sign-in, or `fallback`. */
export function validateRedirectPath(path: string, fallback = '/dash'): string {
  if (!path || typeof path !== 'string') return fallback;
  if (DANGEROUS_CHARACTERS.test(path)) return fallback;

  const trimmed = path.trim();
  if (!trimmed || trimmed.length > MAX_LENGTH) return fallback;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  // Browsers read `\` as `/`.
  if (trimmed.includes('\\')) return fallback;

  const pathEnd = trimmed.search(/[?#]/);
  const rawPath = pathEnd === -1 ? trimmed : trimmed.slice(0, pathEnd);
  const rawRest = pathEnd === -1 ? '' : trimmed.slice(pathEnd);

  // Strict: a segment that will not decode could be hiding `//` from the
  // checks. An `@` matters here only — an email in a table filter is a
  // legitimate query.
  const decodedPath = decodeStrict(rawPath);
  if (
    decodedPath === null ||
    decodedPath.startsWith('//') ||
    decodedPath.includes('@') ||
    decodedPath.includes('\\') ||
    DANGEROUS_CHARACTERS.test(decodedPath)
  ) {
    return fallback;
  }

  // Free text, where a literal `%` (`50%25 off`) is legitimate.
  const decodedRest = decodeLenient(rawRest);
  if (decodedRest.includes('\\') || DANGEROUS_CHARACTERS.test(decodedRest)) {
    return fallback;
  }

  const hashStart = trimmed.indexOf('#');
  const decodedHash =
    hashStart === -1 ? '' : decodeLenient(trimmed.slice(hashStart + 1));
  if (PROTOCOL_PATTERN.test(decodedHash) || decodedHash.startsWith('//')) {
    return fallback;
  }

  let url: URL;
  try {
    url = new URL(trimmed, ORIGIN);
  } catch {
    return fallback;
  }
  // Dot segments can normalise to a protocol-relative `//evil.com`.
  if (url.origin !== ORIGIN || url.pathname.startsWith('//')) return fallback;

  return trimmed;
}
