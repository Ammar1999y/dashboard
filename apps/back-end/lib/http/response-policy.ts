/**
 * The last thing that touches a response.
 *
 * Separate from the `request` hook that also writes the security headers:
 * that hook writes into the framework's mutable header bag, and on Elysia a
 * header on a native `Response` wins over the same key in `set.headers` — so a
 * route, or a dependency, setting its own `Content-Security-Policy` would
 * silently replace the global one. This OVERWRITES instead.
 *
 * The two placements cover different paths: the hook covers the OPTIONS
 * answers `app.ts` keeps outside `mapResponse` (the CORS preflight), this
 * covers every other native `Response`, routing misses and thrown errors
 * included.
 */
import { SECURITY_HEADERS } from './security-headers';

/**
 * Every API response is per-user, credentialed, or an error, and `no-store` is
 * the one directive every intermediary, the back/forward cache included,
 * honours. A handler serving a public cacheable body sets its own
 * `Cache-Control`; this is a default, not an override.
 */
export const DEFAULT_CACHE_CONTROL = 'no-store';

interface ResponsePolicyOptions {
  /**
   * Milliseconds from request admission to response, emitted as
   * `Server-Timing` in development only: elsewhere it would hand a timing
   * probe a jitter-free measurement of the anonymous auth paths. Omitted
   * rather than reported as zero when unmeasured.
   */
  durationMs?: number;
  /** Replaces the API's `Content-Security-Policy` on the one route that serves a page. */
  contentSecurityPolicy?: string;
}

/** Rebuilds responses whose headers are immutable, such as redirects. */
export function applyResponsePolicy(
  response: Response,
  options: ResponsePolicyOptions = {}
): Response {
  try {
    write(response.headers, options);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    write(headers, options);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * The same policy written into a framework's mutable header bag, for an answer
 * the framework serialises itself, so its response schema still applies.
 */
export function applyResponsePolicyToBag(
  bag: Record<string, string | number | string[] | undefined>,
  options: ResponsePolicyOptions = {}
): void {
  write(
    {
      has: (name) => Object.keys(bag).some((key) => key.toLowerCase() === name),
      set: (name, value) => {
        bag[name] = value;
      },
    },
    options
  );
}

function write(
  headers: Pick<Headers, 'has' | 'set'>,
  options: ResponsePolicyOptions
): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS))
    headers.set(key, value);
  if (options.contentSecurityPolicy !== undefined)
    headers.set('content-security-policy', options.contentSecurityPolicy);

  if (!headers.has('cache-control'))
    headers.set('cache-control', DEFAULT_CACHE_CONTROL);

  if (
    options.durationMs !== undefined &&
    process.env.NODE_ENV === 'development'
  )
    headers.set('server-timing', `app;dur=${options.durationMs.toFixed(1)}`);
}
