/**
 * The single parse of the public origin, read by both consumers that must
 * agree on it: `@elysia/cors` in `app.ts` and Better Auth's `baseURL` in
 * `lib/auth/index.ts`, which signs cookies against it.
 *
 * Strict rather than forgiving: the value is compared byte-for-byte against a
 * browser `Origin` header, so anything a browser never sends there (a path, a
 * query, a fragment, `user:pass@`) is a configuration mistake, and repairing
 * it silently is how two consumers come to disagree.
 */

/** Hostnames browsers treat as a secure context regardless of scheme. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const ORIGIN_ENV_NAME = 'PUBLIC_URL';

function readOriginEnv(): string {
  const value = process.env.PUBLIC_URL?.trim();
  if (!value)
    throw new Error(
      `⚠️ Missing required environment variable: ${ORIGIN_ENV_NAME}. ` +
        'It must be an absolute origin, e.g. "https://app.example.com".'
    );
  return value;
}

/**
 * The canonical origin, rejecting everything an origin cannot contain. No
 * scheme is inferred: a guessed one yields a value no browser will match.
 */
function parseOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `⚠️ ${name} is not an absolute URL. Received: "${raw}". ` +
        'Write the full origin including the scheme, e.g. "https://app.example.com".'
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(
      `⚠️ ${name} must use http: or https:. Received scheme: "${url.protocol}".`
    );

  if (url.username || url.password)
    throw new Error(
      `⚠️ ${name} must not contain credentials. Remove the "user:password@" part.`
    );

  if (url.pathname !== '/' && url.pathname !== '')
    throw new Error(
      `⚠️ ${name} must be an origin with no path. Received path: "${url.pathname}".`
    );

  if (url.search)
    throw new Error(`⚠️ ${name} must not contain a query string.`);

  if (url.hash) throw new Error(`⚠️ ${name} must not contain a fragment.`);

  // HTTPS is not merely recommended in production: the session cookie is
  // `Secure`, so an http: origin would deploy an application that cannot hold a
  // session. Localhost is exempt because browsers treat it as a secure context.
  const insecureInProduction =
    url.protocol !== 'https:' &&
    !LOCAL_HOSTNAMES.has(url.hostname) &&
    process.env.NODE_ENV === 'production';
  if (insecureInProduction)
    throw new Error(
      `⚠️ ${name} must use https: in production. Received: "${raw}".`
    );

  return url.origin;
}

/**
 * The browser origin WITH its port (`http://localhost:3000`), and the only
 * exported form of the setting.
 *
 * If the browser and API origins ever need to differ, add a SECOND variable
 * and configure Better Auth `trustedOrigins` explicitly; do not derive a
 * second value from this one.
 */
export const PUBLIC_ORIGIN = parseOrigin(readOriginEnv(), ORIGIN_ENV_NAME);
