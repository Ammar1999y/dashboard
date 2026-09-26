/**
 * The Elysia application — built, not listening, so a route can be executed
 * from a plain `Request` (`app.handle(new Request(...))`) without a socket.
 *
 * The ONLY file that knows the framework. Every endpoint is a
 * framework-agnostic `Handler` (`lib/http/contract.ts`) listed in `routes.ts`
 * and lifted by `toElysiaHandler`; another framework means another adapter and
 * another version of this file, and nothing under `app/api/**` or in
 * `routes.ts`.
 */
import { REGISTERED_ROUTES, ROUTE_PREFIXES } from '@/routes';
import { cors } from '@elysia/cors';
import { Elysia } from 'elysia';

import { auth } from '@/lib/auth';
import { betterAuthServes } from '@/lib/auth/allowed-paths';

import { errorClassOf } from '@/utils/log';

// Load-time gates for the OTP and two-factor configuration; imported here so
// they run when the application is assembled, whatever else imports them.
import '@/lib/otp/config';

import {
  HTTP_STATUS,
  MSG_BODY_TOO_LARGE,
  MSG_INTERNAL_ERROR,
  MSG_METHOD_NOT_ALLOWED,
  MSG_PAGE_NOT_FOUND,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { BASE_ERROR_CODES, CUSTOM_AUTH_CODE } from '@/lib/auth/errors';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { elysiaRouteConfig, toElysiaHandler } from '@/lib/http/adapters/elysia';
import { runAfterResponse } from '@/lib/http/after-response';
import {
  allowlistedPathScope,
  enforcePreAuthIpLimit,
  UNKNOWN_PREFIX_SCOPE,
} from '@/lib/http/pre-auth';
import {
  boundedBodyRequest,
  buildRequestMeta,
  declaresBodyOver,
  MAX_REQUEST_BODY_BYTES,
} from '@/lib/http/request';
import { apiError, handleApiError, toWebResponse } from '@/lib/http/response';
import { applyResponsePolicy } from '@/lib/http/response-policy';
import {
  allowHeader,
  createBodyCeilingLookup,
  createRouteLookup,
} from '@/lib/http/route-manifest';
import { applySecurityHeaders } from '@/lib/http/security-headers';

const lookupMethods = createRouteLookup(REGISTERED_ROUTES, ROUTE_PREFIXES);
const lookupBodyCeiling = createBodyCeilingLookup(
  REGISTERED_ROUTES,
  ROUTE_PREFIXES
);

async function localiseAuthError(response: Response): Promise<Response> {
  if (response.ok) return response;

  const cloned = response.clone();
  let body: unknown;
  try {
    body = await cloned.json();
  } catch {
    return response;
  }

  const code =
    typeof body === 'object' && body !== null && 'code' in body
      ? body.code
      : undefined;
  if (typeof code !== 'string' || !Object.hasOwn(BASE_ERROR_CODES, code))
    return response;

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json;charset=utf-8');
  return Response.json(
    { message: BASE_ERROR_CODES[code], code: CUSTOM_AUTH_CODE },
    { status: response.status, statusText: response.statusText, headers }
  );
}

/**
 * Request start times, for `Server-Timing` and the access log. Keyed by the
 * request, so it needs no framework support and cannot retain an entry for a
 * request whose response was never produced.
 */
const startedAt = new WeakMap<Request, number>();

/**
 * The status actually put on the wire, recorded where the response is produced.
 *
 * Not `set.status`: every handler returns a native `Response`, and `set.status`
 * then still reads its pre-handler default. `onAfterResponse` sees
 * `responseValue` for route responses but not for the ones `onError` produces,
 * so the two sources together cover every path.
 */
const finalStatus = new WeakMap<Request, number>();

/** The single exit for a response this file produces. */
function finish(request: Request, response: Response): Response {
  finalStatus.set(request, response.status);
  const started = startedAt.get(request);
  return applyResponsePolicy(response, {
    durationMs: started === undefined ? undefined : performance.now() - started,
  });
}

/**
 * CORS policy. **Also one of the three things standing in for a CSRF token —
 * read it as a security control.** There is deliberately no CSRF token; a
 * fourth mechanism would duplicate these three:
 *
 * 1. Better Auth's routes are origin-checked: `originCheckMiddleware`
 *    validates `Origin`/`Referer` against `trustedOrigins` (default `baseURL`,
 *    which is `PUBLIC_ORIGIN`) on every non-GET request carrying a cookie.
 * 2. The session cookie is `SameSite=Lax` (Better Auth's default; nothing here
 *    sets `advanced.defaultCookieAttributes`), so a cross-site POST/PUT/DELETE
 *    arrives with no session.
 * 3. Application JSON routes require exactly `application/json`
 *    (`lib/http/request.ts`), which is not CORS-simple, so a cross-site attempt
 *    needs a preflight that only the origin below passes.
 *
 * Layer 3 does not cover `multipart/form-data`, which IS CORS-simple. Both
 * upload routes (`app/api/upload/file/handler.ts`,
 * `app/api/dash/media/files/handler.ts`) are session-gated and layer 2 keeps
 * the cookie off such a request; `bun run smoke` asserts the 401. **Any future
 * multipart or form-encoded route inherits this gap and needs the same
 * treatment.**
 */
const CORS_POLICY = {
  // Not `*`: these endpoints are credentialed, and browsers refuse `*` with
  // credentials.
  origin: PUBLIC_ORIGIN,
  credentials: true,
  // `HEAD` is advertised because the runtime serves it from every `GET` route.
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // `X-Captcha-Response` is required: `lib/captcha.ts` reads the token from it.
  // Without it the preflight still answers 204, so `curl` looks healthy while
  // every browser blocks the real request.
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Captcha-Response',
    'X-Maintenance-Token',
  ],
  // Without these a rate-limited UI cannot tell the user when to retry.
  exposeHeaders: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  // The plugin default re-fires a preflight for practically every request;
  // ten minutes is the common ceiling browsers honour.
  maxAge: 600,
} as const;

/** Lets shutdown honor the longest route-specific timeout. */
export const MAX_ROUTE_TIMEOUT_SECONDS = REGISTERED_ROUTES.reduce(
  (longest, route) => Math.max(longest, route.timeoutSeconds ?? 0),
  0
);

function notFound(): Response {
  return toWebResponse(
    apiError({ message: MSG_PAGE_NOT_FOUND, status: HTTP_STATUS.NOT_FOUND })
  );
}

/**
 * The 308 to the slash-free form of a path, or null if there is nothing to
 * canonicalise. Only for a path that exists without the slash, so an unknown
 * path stays a 404 rather than becoming a redirect oracle.
 */
function canonicalRedirect(url: URL): Response | null {
  if (url.pathname.length <= 1 || !url.pathname.endsWith('/')) return null;
  const target = url.pathname.slice(0, -1);
  if (lookupMethods(target).size === 0) return null;

  // Not `Response.redirect`, whose headers are immutable and would make the
  // response policy clone around them.
  return new Response(null, {
    status: HTTP_STATUS.PERMANENT_REDIRECT,
    headers: { Location: target + url.search },
  });
}

// Short Host values can make Elysia route against a suffix of the real path.
const MIN_ROUTABLE_HOSTNAME_LENGTH = 4;

/**
 * 404 or 405, decided from the route lookup — Elysia reports both as
 * `NOT_FOUND`, and only the table can tell them apart.
 */
function routeMiss(pathname: string): Response {
  const methods = lookupMethods(pathname);
  if (methods.size === 0) return notFound();

  return toWebResponse({
    status: HTTP_STATUS.METHOD_NOT_ALLOWED,
    body: { success: false, message: MSG_METHOD_NOT_ALLOWED, data: null },
    headers: { Allow: allowHeader(methods) },
  });
}

const base = new Elysia({
  // Elysia's default accepts both `/x` and `/x/`; two URLs for one resource
  // split cache keys and security-rule matching. `canonicalRedirect` answers
  // the slash form with a 308 instead.
  strictPath: true,
  serve: {
    // Fail a second bind instead of letting the kernel split traffic silently.
    reusePort: false,
    // Bun's default is buffered before any per-file check can run. The
    // per-file limit stays: it is per file, this is per request.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  },
})
  // Registered BEFORE the CORS plugin: hooks run in registration order, and the
  // plugin answers a preflight from its own `onRequest`. This covers the two
  // paths that never reach `mapResponse`: the preflight short-circuit and the
  // unmatched path.
  .onRequest(({ set, request }) => {
    startedAt.set(request, performance.now());
    applySecurityHeaders(set.headers);

    // `URL.parse`, not `new URL`: Bun serves a request whose `Host` it cannot
    // use, leaving `request.url` as the bare path or an authority `new URL`
    // rejects, and that throw would reach `onError` as an unauthenticated 500
    // ahead of every rate limit. An unparseable host is unroutable.
    //
    // ⚠️ Every later `new URL(request.url)` — `onError`, the auth prefix route,
    // `buildRequestMeta` — relies on this return, because routing does not run
    // once an `onRequest` hook has answered. A hook registered ahead of this
    // one, or a mount outside Elysia, would reach them unguarded.
    const url = URL.parse(request.url);
    if (!url || url.hostname.length < MIN_ROUTABLE_HOSTNAME_LENGTH)
      return finish(request, notFound());

    // The ONE ceiling every request crosses, decided from the path alone, so a
    // mount that reads its own body (`/api/auth/*`) cannot opt out of it and a
    // caller's `Content-Type` cannot widen it.
    //
    // `Content-Length` only, because this hook must not touch the stream. A
    // chunked request declares no length; the counting half is applied where
    // the body is read — `readBoundedText` for table routes,
    // `boundedBodyRequest` at the Better Auth prefix below.
    if (declaresBodyOver(request, lookupBodyCeiling(url.pathname)))
      return finish(
        request,
        toWebResponse(
          handleApiError(
            new CustomError(MSG_BODY_TOO_LARGE, HTTP_STATUS.CONTENT_TOO_LARGE)
          )
        )
      );

    // Route-aware OPTIONS, ahead of the CORS plugin's own `OPTIONS /*`
    // catch-all, which answers 204 on any path. The trailing-slash redirect is
    // repeated here because this hook short-circuits before the router, and an
    // OPTIONS on the slash form must get the same 308 as every other method.
    if (
      request.method === 'OPTIONS' &&
      lookupMethods(url.pathname).size === 0
    ) {
      const canonical = canonicalRedirect(url);
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
  // In addition to the `onRequest` hook, not instead of it: a header on a
  // native `Response` wins over `set.headers`, so this runs last and
  // overwrites. See `lib/http/response-policy.ts`.
  .mapResponse(({ responseValue, request }) => {
    if (!(responseValue instanceof Response)) return;
    return finish(request, responseValue) as never;
  })
  // One wiring line by design; the work lives in `lib/http/after-response.ts`.
  .onAfterResponse(({ request, set, path, responseValue }) => {
    const started = startedAt.get(request);
    startedAt.delete(request);
    const stamped = finalStatus.get(request);
    finalStatus.delete(request);
    runAfterResponse(request, {
      method: request.method,
      path,
      status:
        stamped ??
        (responseValue instanceof Response
          ? responseValue.status
          : typeof set.status === 'number'
            ? set.status
            : 200),
      durationMs: started === undefined ? 0 : performance.now() - started,
    });
  })
  .onError(({ code, error, set, request }) => {
    // Re-applied: an error thrown inside `onRequest` lands here before that
    // hook finished.
    applySecurityHeaders(set.headers);

    if (code === 'NOT_FOUND') {
      const url = new URL(request.url);
      const canonical = canonicalRedirect(url);
      if (canonical) return finish(request, canonical);

      return finish(request, routeMiss(url.pathname));
    }

    // A framework-level fault that escaped `toElysiaHandler`'s own catch. The
    // message is never echoed: it can carry internals.
    console.error(
      JSON.stringify({
        msg: 'unhandled server error',
        code,
        errorClass: errorClassOf(error),
      })
    );
    return finish(
      request,
      toWebResponse(
        apiError({
          message: MSG_INTERNAL_ERROR,
          status: HTTP_STATUS.INTERNAL_ERROR,
        })
      )
    );
  });

/** Applies the route table and the Better Auth prefix to a built instance. */
function register(instance: typeof base): typeof base {
  for (const route of REGISTERED_ROUTES)
    instance.route(
      route.method,
      route.path,
      toElysiaHandler(route),
      elysiaRouteConfig
    );

  /**
   * Better Auth, registered last and as a prefix so every explicit route above
   * wins: Elysia resolves static segments before wildcards. `parse: 'none'`
   * keeps the body stream intact — Better Auth reads the request itself.
   *
   * **The allowlist is enforced HERE, before `auth.handler` is called.** The
   * `before` hook in `lib/auth/path-policy.ts` enforces it too, but Better Auth
   * runs every plugin's `onRequest` ahead of its hooks, so only this check is
   * upstream of a plugin that matches its endpoints loosely (the captcha
   * plugin would spend an outbound siteverify on an unrouted path). Both stay.
   */
  for (const prefix of ROUTE_PREFIXES) {
    // Only the methods some sub-path serves; the rest stop at the 405 boundary.
    const registered = new Set(prefix.paths.flatMap((entry) => entry.methods));
    for (const method of registered)
      instance.route(
        method,
        `${prefix.prefix}/*`,
        async ({ request }: { request: Request }) => {
          const url = new URL(request.url);
          const subPath = url.pathname.slice(prefix.prefix.length);
          const known = prefix.paths.find((path) => path.path === subPath);
          try {
            // Admission precedes the plugins that perform outbound work. An
            // allowlisted path gets its own key, so a budget declared per path
            // is counted per path; everything else shares ONE fixed key, so
            // rotating `/api/auth/<random>` multiplies neither the budget nor
            // the `rate_limit` keyspace.
            await enforcePreAuthIpLimit(buildRequestMeta(request), {
              limit: known?.preAuthLimit,
              scope: known
                ? allowlistedPathScope(`${prefix.prefix}${known.path}`)
                : UNKNOWN_PREFIX_SCOPE,
            });
            // `routeMiss`, not `notFound`: table routes live under this prefix
            // too (`/api/auth/otp/*`, `/api/auth/forgot-password/*`, ...), and a
            // wrong method on one falls through this wildcard. `routeMiss`
            // still answers 404 for a genuinely unknown sub-path.
            if (!known)
              return canonicalRedirect(url) ?? routeMiss(url.pathname);
            if (!betterAuthServes(subPath, request.method))
              return routeMiss(url.pathname);
            // Better Auth answers 404 for a HEAD on a path it serves for GET,
            // and Elysia dispatches HEAD to the GET registration, so the
            // substitution happens here. `new Request(url, …)` is a GET; the
            // runtime discards the body.
            const forwarded =
              request.method === 'HEAD'
                ? new Request(request.url, { headers: request.headers })
                : // The counting half of the ceiling the `onRequest` hook
                  // declares: a chunked body declares nothing, and Better Auth
                  // reads it itself. Same lookup as the hook, so the two halves
                  // cannot drift.
                  await boundedBodyRequest(
                    request,
                    lookupBodyCeiling(url.pathname)
                  );
            return localiseAuthError(await auth.handler(forwarded));
          } catch (error) {
            // This wildcard bypasses the adapter that normally maps API
            // errors — the 413 `boundedBodyRequest` throws included.
            return toWebResponse(handleApiError(error));
          }
        },
        elysiaRouteConfig
      );
  }

  return instance;
}

export const app = register(base);
