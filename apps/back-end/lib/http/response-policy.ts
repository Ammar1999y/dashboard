/**
 * The last thing that touches a response.
 *
 * Separate from the `onRequest` hook that also writes the security headers:
 * that hook writes into the framework's mutable header bag, and on Elysia a
 * header on a native `Response` wins over the same key in `set.headers` — so a
 * route, or a dependency, setting its own `Content-Security-Policy` would
 * silently replace the global one. This OVERWRITES instead.
 *
 * The two placements cover different paths: the hook covers what never reaches
 * `mapResponse` (the CORS preflight short-circuit, the unmatched path), this
 * covers every native `Response` produced, thrown errors included.
 */
import { DEFAULT_CACHE_CONTROL } from './response';
import { SECURITY_HEADERS } from './security-headers';

interface ResponsePolicyOptions {
  /**
   * Milliseconds from request admission to response, emitted as
   * `Server-Timing`. Omitted rather than reported as zero when unmeasured.
   */
  durationMs?: number;
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

function write(headers: Headers, options: ResponsePolicyOptions): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS))
    headers.set(key, value);

  // Preserve an explicit cache policy from the handler.
  if (!headers.has('cache-control'))
    headers.set('cache-control', DEFAULT_CACHE_CONTROL);

  if (options.durationMs !== undefined)
    headers.set('server-timing', `app;dur=${options.durationMs.toFixed(1)}`);
}
