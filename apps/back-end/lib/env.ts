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

/** Accepted names, in precedence order. `NEXT_PUBLIC_URL` is the legacy name. */
const ORIGIN_ENV_NAMES = ['PUBLIC_URL', 'NEXT_PUBLIC_URL'] as const;

interface ConfiguredOrigin {
  name: string;
  value: string;
}

function readOriginEnv(): ConfiguredOrigin {
  const present: ConfiguredOrigin[] = [];
  for (const name of ORIGIN_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) present.push({ name, value });
  }

  if (present.length === 0)
    throw new Error(
      `⚠️ Missing required environment variable: ${ORIGIN_ENV_NAMES[0]} (legacy name: ${ORIGIN_ENV_NAMES[1]}). ` +
        'It must be an absolute origin, e.g. "https://app.example.com".'
    );

  const [first, ...rest] = present;
  // `present.length === 0` is rejected above, so this only narrows the type.
  if (!first) throw new Error('unreachable: no configured origin');
  for (const other of rest)
    if (other.value !== first.value)
      throw new Error(
        `⚠️ ${first.name} and ${other.name} are both set to different values. ` +
          `Unset ${other.name} and keep ${first.name}.`
      );

  return first;
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

const configured = readOriginEnv();

/**
 * The browser origin WITH its port (`http://localhost:3000`), and the only
 * exported form of the setting.
 *
 * If the browser and API origins ever need to differ, add a SECOND variable
 * and configure Better Auth `trustedOrigins` explicitly; do not derive a
 * second value from this one.
 */
export const PUBLIC_ORIGIN = parseOrigin(configured.value, configured.name);
