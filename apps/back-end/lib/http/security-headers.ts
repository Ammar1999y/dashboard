/**
 * Response security headers for a server that serves ONLY a JSON API.
 *
 * - The CSP is `default-src 'none'`: no response should ever be treated as a
 *   document, and denying every fetch directive says exactly that.
 * - They apply in development too, so a header bug surfaces locally. HSTS is
 *   the exception: on `http://localhost` it pins the whole host to HTTPS in the
 *   developer's browser, unrelated projects on other ports included.
 *
 * CORS is not here: `@elysia/cors` in `app.ts` answers preflights and sets
 * `Vary: Origin`, which a static `Access-Control-Allow-Origin` cannot.
 */

const isProduction = process.env.NODE_ENV === 'production';

const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze(
  {
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    // Disables the legacy, buggy XSS auditor rather than enabling it.
    'X-XSS-Protection': '0',
    'Origin-Agent-Cluster': '?1',
    'X-DNS-Prefetch-Control': 'off',
    'X-Permitted-Cross-Domain-Policies': 'none',
    ...(isProduction && {
      'Strict-Transport-Security':
        'max-age=63072000; includeSubDomains; preload',
    }),
  }
);

/**
 * Writes the header set onto a framework's mutable header bag — key by key,
 * because the CORS plugin has already written `Access-Control-Allow-Origin` and
 * `Vary` there and replacing the bag would drop them.
 */
export function applySecurityHeaders(
  target: Record<string, string | number | undefined>
): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS))
    target[key] = value;
}
