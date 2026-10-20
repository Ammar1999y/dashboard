/**
 * The Elysia application — built, not listening, so a route can be executed
 * from a plain `Request` (`app.handle(new Request(...))`) without a socket.
 *
 * The instance, the `request` hook and CORS. Every other Elysia-specific piece
 * lives in `server/elysia/`; everything a request is checked against lives in
 * core (`lib/http/`), which never imports the framework.
 */
import { REGISTERED_BINDINGS } from '@/modules';
import { cors } from '@elysia/cors';
import { Elysia } from 'elysia';

// Load-time gates for the OTP and two-factor configuration; imported here so
// they run when the application is assembled, whatever else imports them.
import '@/lib/otp/config';

import type { AnyBinding } from '@/lib/http/binding';
import type { RoutePrefix, Routing } from '@/lib/http/routing';

import { mountAuthPrefix } from '@/server/elysia/auth-mount';
import { errorMapping } from '@/server/elysia/errors';
import { gate } from '@/server/elysia/gate';
import {
  mountReferencePage,
  REFERENCE_PAGE_ROUTE,
  serveDocument,
} from '@/server/elysia/openapi';
import {
  assertEveryRouteHooked,
  registerBinding,
} from '@/server/elysia/register';
import {
  answerEarly,
  exitStep,
  finish,
  markPreflight,
  markStarted,
} from '@/server/elysia/respond';

import { BETTER_AUTH_ROUTE_PREFIX } from '@/lib/auth/allowed-paths';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { routeShapeOf } from '@/lib/http/binding';
import {
  bodyTooLarge,
  declaresBodyOver,
  MAX_REQUEST_BODY_BYTES,
} from '@/lib/http/request';
import { handleApiError, toWebResponse } from '@/lib/http/response';
import { createRouting, isRoutableHost, notFound } from '@/lib/http/routing';
import { applySecurityHeaders } from '@/lib/http/security-headers';

/**
 * CORS policy. **Also one of the things standing in for a CSRF token — read it
 * as a security control.** There is deliberately no CSRF token:
 *
 * 1. Better Auth's routes are origin-checked: `originCheckMiddleware`
 *    validates `Origin`/`Referer` against `trustedOrigins` (default `baseURL`,
 *    which is `PUBLIC_ORIGIN`) on every non-GET request carrying a cookie.
 * 2. The session cookie is `SameSite=Lax` (Better Auth's default; nothing here
 *    sets `advanced.defaultCookieAttributes`), so a cross-site POST/PUT/DELETE
 *    arrives with no session. A same-site sibling origin still gets the cookie.
 * 3. Bindings refuse a write whose `Origin` or
 *    `Sec-Fetch-Site` names another origin (`lib/http/origin.ts`). This is the only layer covering a
 *    body-less POST or `multipart/form-data`, which are CORS-simple; a JSON
 *    route also needs a preflight, since `application/json` is not.
 */
const CORS_POLICY = {
  // Not `*`: these endpoints are credentialed, and browsers refuse `*` with
  // credentials.
  origin: PUBLIC_ORIGIN,
  credentials: true,
  // `HEAD` is advertised because `register` serves it from every `GET` route.
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // `X-Captcha-Response` is required: `lib/captcha.ts` reads the token from it.
  // Without it the preflight still answers 204, so `curl` looks healthy while
  // every browser blocks the real request.
  allowedHeaders: ['Content-Type', 'X-Captcha-Response'],
  // Without these a rate-limited UI cannot tell the user when to retry.
  exposeHeaders: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  // The plugin default re-fires a preflight for practically every request;
  // ten minutes is the common ceiling browsers honour.
  maxAge: 600,
} as const;

/**
 * What the CORS plugin's own `request` hook writes, for an answer the `request`
 * hook below gives before that one runs: without it a cross-origin dashboard
 * reads the refusal as a network error. The plugin's defaults (credentials,
 * the allowed and exposed headers) are on every answer already.
 */
function writeCorsOrigin(
  headers: Record<string, string | number | string[]>,
  request: Request
): void {
  headers.vary = 'Origin';
  if (request.headers.get('origin') !== CORS_POLICY.origin) return;
  headers['access-control-allow-origin'] = CORS_POLICY.origin;
  headers['access-control-allow-methods'] = CORS_POLICY.methods.join(', ');
}

/** Lets shutdown honor the longest route-specific timeout. */
export const MAX_ROUTE_TIMEOUT_SECONDS = Math.max(
  0,
  ...REGISTERED_BINDINGS.map((binding) => binding.options.timeoutSeconds ?? 0)
);

/**
 * ⚠️ Every hook is registered here, before the first route: Elysia copies the
 * hooks a route can see when the route is registered, so an `error`,
 * `mapResponse` or `afterResponse` hook added after a route never runs for it.
 * Only `request` hooks apply wherever they are added.
 */
function createBase(routing: Routing) {
  return (
    new Elysia({
      // Elysia's default accepts both `/x` and `/x/`; two URLs for one resource
      // split cache keys and security-rule matching. `canonicalRedirect` answers
      // the slash form with a 308 instead.
      strictPath: true,
      // Elysia's default stops a request whose client went away after the current
      // hook, skipping `afterResponse`: a handler that already committed would
      // lose its access line and its after-response queue.
      abortSignal: false,
      // Every route is compiled when the fetch handler is built (`listen`, or the
      // first `handle`), not on its own first request.
      precompile: true,
      serve: {
        // Fail a second bind instead of letting the kernel split traffic silently.
        reusePort: false,
        // Bun's default is buffered before any per-file check can run. The
        // per-file limit stays: it is per file, this is per request.
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      },
    })
      .request(({ set, request }) => {
        markStarted(request);
        applySecurityHeaders(set.headers);
        const early = (logPath: string, response: Response) => {
          writeCorsOrigin(set.headers, request);
          return answerEarly(request, logPath, response);
        };

        // `URL.parse`, not `new URL`: Bun serves a request whose `Host` it cannot
        // use, leaving `request.url` as the bare path or an authority `new URL`
        // rejects, and that throw would reach the `error` hook as an
        // unauthenticated 500 ahead of every rate limit. An unparseable host is
        // unroutable.
        //
        // ⚠️ Every later `new URL(request.url)` — the `error` hook, the auth prefix
        // route, `buildRequestMeta` — relies on this return, because routing does
        // not run once a `request` hook has answered. A hook registered ahead of
        // this one, or a mount outside Elysia, would reach them unguarded.
        const url = URL.parse(request.url);
        if (!url || !isRoutableHost(url))
          return early(url?.pathname ?? request.url, notFound());

        // The ONE ceiling every request crosses, decided from the path alone, so a
        // mount that reads its own body (`/api/auth/*`) cannot opt out of it and a
        // caller's `Content-Type` cannot widen it.
        //
        // `Content-Length` only, because this hook must not touch the stream. A
        // chunked request declares no length; the counting half is applied where
        // the body is read — `readBoundedText` for bindings,
        // `boundedBodyRequest` at the Better Auth prefix.
        if (declaresBodyOver(request, routing.lookupBodyCeiling(url.pathname)))
          return early(
            url.pathname,
            toWebResponse(handleApiError(bodyTooLarge()))
          );

        if (request.method !== 'OPTIONS') return;
        markPreflight(request);

        // Route-aware OPTIONS, ahead of the CORS plugin's own `OPTIONS /*`
        // catch-all, which answers 204 on any path. The trailing-slash redirect is
        // repeated here because this hook short-circuits before the router, and an
        // OPTIONS on the slash form must get the same 308 as every other method.
        if (routing.lookupMethods(url.pathname).size === 0) {
          const canonical = routing.canonicalRedirect(url);
          return finish(request, canonical ?? notFound());
        }
      })
      // Spread into mutable arrays: the plugin's option type is `string[]`, and the
      // policy is `readonly` so nothing can mutate it.
      .use(
        cors({
          ...CORS_POLICY,
          methods: [...CORS_POLICY.methods],
          allowedHeaders: [...CORS_POLICY.allowedHeaders],
          exposeHeaders: [...CORS_POLICY.exposeHeaders],
        })
      )
      .use(exitStep(routing.servedByPrefix))
      .use(
        errorMapping((request) => {
          const url = new URL(request.url);
          return (
            routing.canonicalRedirect(url) ?? routing.routeMiss(url.pathname)
          );
        })
      )
      .use(gate)
  );
}

/** The instance every route is registered on, its hooks and the gate macro in place. */
export type GatedApp = ReturnType<typeof createBase>;

interface Surface {
  bindings: readonly AnyBinding[];
  prefixes: readonly RoutePrefix[];
  /** Whether `GET /openapi.json` serves this instance's document; one instance per process does. */
  servesDocument?: boolean;
  /** The Scalar page, never outside development. */
  referencePage?: boolean;
}

/**
 * The application over a given surface. Hooks first, then bindings, then the
 * Better Auth prefix; the boot fails if any route missed a hook.
 */
export function createApp({
  bindings,
  prefixes,
  servesDocument = false,
  referencePage = false,
}: Surface) {
  const routing = createRouting(
    [
      ...bindings.map(routeShapeOf),
      ...(referencePage ? [REFERENCE_PAGE_ROUTE] : []),
    ],
    prefixes
  );
  const base = createBase(routing);
  for (const binding of bindings) registerBinding(base, binding);
  // The only two registrations outside `bind()`: an HTML page and a library
  // that routes itself. Every API route is a binding.
  if (referencePage) mountReferencePage(base);
  for (const prefix of prefixes) mountAuthPrefix(base, prefix, routing);
  assertEveryRouteHooked(base);
  if (servesDocument) serveDocument(base, bindings);
  return base;
}

export const app = createApp({
  bindings: REGISTERED_BINDINGS,
  prefixes: [BETTER_AUTH_ROUTE_PREFIX],
  servesDocument: true,
  referencePage: process.env.NODE_ENV === 'development',
});
