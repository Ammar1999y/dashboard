// `next.config.js` loads this file too, so it stays plain JavaScript.

const isApiMocking = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled';

/**
 * Where a mock build sends its API requests. The mocks answer them in the
 * browser; a request they miss fails to resolve rather than reaching a server
 * with real data.
 */
const MOCK_API_ORIGIN = 'https://api.mock.invalid';
/** The ports `dev:mock` (Next's default) and `start:mock` serve on, in `package.json`. */
const MOCK_PUBLIC_URL =
  process.env.NODE_ENV === 'production'
    ? 'http://localhost:3123'
    : 'http://localhost:3000';

/**
 * @param {string | undefined} value
 * @param {string} name
 * @param {{ secure: boolean }} options `secure` forces https.
 * @returns {string} The URL's origin.
 */
function toOrigin(value, name, { secure }) {
  const trimmed = value?.trim();
  if (!trimmed)
    throw new Error(`Environment variable '${name}' is empty or missing.`);

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `${secure ? 'https' : 'http'}://${trimmed}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error(
      `Invalid URL in environment variable '${name}': "${trimmed}".`
    );
  }
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error(
      `Environment variable '${name}' must be an origin, without a path: "${trimmed}".`
    );
  if (secure) url.protocol = 'https:';
  return url.origin;
}

const publicUrl =
  process.env.NEXT_PUBLIC_URL || (isApiMocking ? MOCK_PUBLIC_URL : undefined);
const PUBLIC_URL = toOrigin(publicUrl, 'NEXT_PUBLIC_URL', {
  secure:
    process.env.NODE_ENV === 'production' &&
    !publicUrl?.startsWith('http://localhost:'),
});

const API_URL = isApiMocking
  ? MOCK_API_ORIGIN
  : toOrigin(process.env.NEXT_PUBLIC_API_URL, 'NEXT_PUBLIC_API_URL', {
      secure: false,
    });

export { API_URL, PUBLIC_URL };
