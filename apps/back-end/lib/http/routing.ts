/**
 * The answers routing itself gives: 404, 405 with `Allow`, the 308 to a
 * path's slash-free form, and the body ceiling a path admits. One lookup over
 * the bindings and the prefixes, because the framework reports a wrong method
 * and an unknown path alike.
 */
import type { BodyPolicy } from './contract';

import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_METHOD_NOT_ALLOWED,
  MSG_PAGE_NOT_FOUND,
} from '@app/shared/messages/common';

import { bodyPolicyCeiling } from './request';
import { apiError, toWebResponse } from './response';

/**
 * Methods this application registers. Not `string`: the 405 boundary
 * advertises this set in `Allow`, and a typo would advertise a method that
 * routes nowhere.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * What `Allow` may name. `HEAD` is derived from `GET`, never declared, so a
 * route must not be able to declare it.
 */
type AdvertisedMethod = HttpMethod | 'HEAD';

/** What the lookups read of a binding. */
export interface RouteShape {
  method: HttpMethod;
  /** Framework-neutral path with `:name` params, e.g. `/api/dash/users/:id`. */
  path: string;
  body: BodyPolicy;
  /** Raises the JSON body ceiling above `MAX_JSON_BODY_BYTES`. */
  maxJsonBodyBytes?: number;
}

/** One sub-path of a prefix, with the methods that path actually answers. */
export interface RoutePrefixPath {
  /** Relative to the prefix, e.g. `/sign-out`. */
  path: string;
  methods: readonly HttpMethod[];
  /**
   * The per-IP admission budget for this path, overriding `PRE_AUTH_LIMIT`.
   * Required: a session read on every dashboard navigation and a credential
   * submission need budgets an order of magnitude apart.
   */
  preAuthLimit: number;
  /** Whether this Better Auth endpoint requires `x-captcha-response`. */
  captcha: boolean;
  /**
   * Which credential this path needs, and therefore what the OpenAPI document
   * publishes as its `security`. Required: an undeclared credential publishes
   * as anonymous, and a generated client then omits the cookie.
   *
   * - `'session'` — 401 without a session cookie.
   * - `'optional'` — answers with or without one (`/get-session`, `/sign-out`).
   * - `'challenge'` — the second step of sign-in; 401 without the two-factor
   *   challenge cookie, which has its own scheme.
   * - `'session-or-challenge'` — one endpoint serving both enrolment and the
   *   second step, taking EITHER credential (`/two-factor/otp/*`).
   * - `'none'` — anonymous, or gated by a credential no scheme describes: an
   *   OAuth state cookie, a single-use grant.
   */
  session:
    'session' | 'optional' | 'challenge' | 'session-or-challenge' | 'none';
}

/**
 * A path prefix served by a handler that owns its own sub-routing — Better
 * Auth, which takes the raw `Request` and so is not a binding. It still feeds
 * the lookups, or the 405 boundary would answer 404 for a wrong method under
 * `/api/auth/*`.
 */
export interface RoutePrefix {
  /** Prefix WITHOUT the trailing wildcard, e.g. `/api/auth`. */
  prefix: string;
  /**
   * What the prefix handler may read, for the WHOLE prefix: the ceiling is
   * decided in the `request` hook, before the router has matched a sub-path.
   * Sub-paths that disagreed would need this moved down to `RoutePrefixPath`
   * and a sub-path lookup at that boundary.
   */
  body: BodyPolicy;
  /**
   * The exact sub-paths served, each with its own methods, so neither an
   * unknown sub-path nor an unserved method is advertised in `Allow` or in the
   * document.
   */
  paths: readonly RoutePrefixPath[];
}

const DEVELOPMENT_ONLY_PREFIXES = ['/api/dev/'] as const;

/**
 * Is this path development-only — both unregistered and unpublished outside
 * development? One predicate for both decisions, so a future `/api/dev/*` route
 * cannot be registered in production by a handler that forgets its own
 * `NODE_ENV` check.
 */
export function isDevelopmentOnlyPath(path: string): boolean {
  return DEVELOPMENT_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Compiles a `:param` path into an anchored matcher. A param matches one
 * segment and never a `/`; every other segment is escaped.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? '[^/]+'
        : segment.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    )
    .join('/');
  // eslint-disable-next-line security/detect-non-literal-regexp -- `path` comes from a binding's contract entry, never from a request, and every non-param segment is escaped above
  return new RegExp(`^${source}$`);
}

/**
 * Answers "which methods does this pathname actually answer?" for the
 * 404-vs-405 boundary and route-aware OPTIONS.
 *
 * `HEAD` is derived from `GET` for every registration: `server/elysia/`
 * registers each GET route (a binding's, the reference page's) for HEAD too,
 * and `betterAuthServes` answers HEAD from the GET entry. They must keep
 * agreeing.
 */
function createRouteLookup(
  routes: readonly RouteShape[],
  prefixes: readonly RoutePrefix[]
): (pathname: string) => Set<AdvertisedMethod> {
  const compiled = routes.map((route) => ({
    matcher: compile(route.path),
    method: route.method,
  }));

  return (pathname: string) => {
    const methods = new Set<AdvertisedMethod>();
    for (const entry of compiled)
      if (entry.matcher.test(pathname)) addServed(methods, entry.method);
    for (const entry of prefixes)
      for (const sub of entry.paths)
        if (pathname === `${entry.prefix}${sub.path}`)
          for (const method of sub.methods) addServed(methods, method);
    return methods;
  };
}

function addServed(methods: Set<AdvertisedMethod>, method: HttpMethod): void {
  methods.add(method);
  if (method === 'GET') methods.add('HEAD');
}

/**
 * Answers "how many body bytes may this pathname carry?" for the admission
 * boundary in `app.ts`, which decides before the router has matched anything.
 *
 * The ceiling follows the POLICY each binding declares, so a caller cannot buy
 * the multipart allowance by writing `multipart/form-data` on a JSON-only
 * endpoint. A path that matches nothing takes the smaller default: it is about
 * to 404.
 *
 * The LARGEST ceiling wins when two methods on one path disagree: this bound is
 * coarse by construction, the body reader applies the exact per-binding value
 * again, and taking the smallest would refuse a request the route it belongs to
 * accepts.
 */
function createBodyCeilingLookup(
  routes: readonly RouteShape[],
  prefixes: readonly RoutePrefix[]
): (pathname: string) => number {
  const compiled = routes.map((route) => ({
    matcher: compile(route.path),
    ceiling: bodyPolicyCeiling(route.body, route.maxJsonBodyBytes),
  }));
  const prefixCeilings = prefixes.map((entry) => ({
    prefix: entry.prefix,
    ceiling: bodyPolicyCeiling(entry.body),
  }));

  return (pathname: string) => {
    let ceiling: number | undefined;
    for (const entry of compiled)
      if (entry.matcher.test(pathname))
        ceiling = Math.max(ceiling ?? 0, entry.ceiling);
    if (ceiling !== undefined) return ceiling;
    for (const entry of prefixCeilings)
      if (pathname.startsWith(`${entry.prefix}/`)) return entry.ceiling;
    return bodyPolicyCeiling('json');
  };
}

/**
 * The `Allow` header value for a path that has registrations. `OPTIONS` is
 * added because the CORS layer answers it on every known path; `HEAD` comes
 * only from the lookup, which knows whether it is served.
 */
function allowHeader(methods: ReadonlySet<AdvertisedMethod>): string {
  const advertised = new Set<string>(methods);
  advertised.add('OPTIONS');
  return [...advertised].join(', ');
}

// Elysia 1 routed a Host this short against a suffix of the real path. Elysia 2
// does not, but it still cuts the path out of the URL by position.
const MIN_ROUTABLE_HOSTNAME_LENGTH = 4;

/** A host the application refuses 404 before routing, whatever the path. */
export const isRoutableHost = (url: URL): boolean =>
  url.hostname.length >= MIN_ROUTABLE_HOSTNAME_LENGTH;

export function notFound(): Response {
  return toWebResponse(
    apiError({ message: MSG_PAGE_NOT_FOUND, status: HTTP_STATUS.NOT_FOUND })
  );
}

export function createRouting(
  routes: readonly RouteShape[],
  prefixes: readonly RoutePrefix[]
) {
  const lookupMethods = createRouteLookup(routes, prefixes);

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

  /** 404 or 405, decided from the lookup. */
  function routeMiss(pathname: string): Response {
    const methods = lookupMethods(pathname);
    if (methods.size === 0) return notFound();

    return toWebResponse(
      apiError({
        message: MSG_METHOD_NOT_ALLOWED,
        status: HTTP_STATUS.METHOD_NOT_ALLOWED,
        headers: { Allow: allowHeader(methods) },
      })
    );
  }

  return {
    lookupMethods,
    lookupBodyCeiling: createBodyCeilingLookup(routes, prefixes),
    canonicalRedirect,
    routeMiss,
  };
}

export type Routing = ReturnType<typeof createRouting>;
