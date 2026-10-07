/**
 * The route table as data, and everything derived from it.
 *
 * A route is a record with REQUIRED policy fields, so omitting `preAuth`,
 * `auth` or `body` does not compile. The framework file iterates this list
 * rather than carrying it, and the lookups below are derived from the
 * registrations themselves rather than maintained alongside them.
 */
import type { BodyPolicy, Handler } from './contract';

import { bodyPolicyCeiling } from './request';
import { responseCheckMode, withResponseCheck } from './response-check';

/**
 * Methods this application registers. Not `string`: the 405 boundary
 * advertises this set in `Allow`, and a typo would advertise a method that
 * routes nowhere.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * What `Allow` may name. `HEAD` is derived from `GET`, never registered, so a
 * route table entry must not be able to declare it.
 */
type AdvertisedMethod = HttpMethod | 'HEAD';

/** Whether the coarse per-IP admission limit runs before the handler. */
type PreAuthPolicy = 'ip-limit' | 'none';

/**
 * Which authentication refusals the handler can answer, and so which 401/403
 * the document publishes. Nothing static can derive it: the check lives inside
 * the handler, often behind a helper.
 *
 * `permission` includes `session`: every permission check reads the session
 * first and answers 401 without one (`lib/permissions/checker.ts`), then 403.
 */
type AuthPolicy = 'public' | 'session' | 'permission';

type ResponsePolicy = 'envelope' | 'openapi-document' | 'storage-health';

/**
 * A query-string parameter a route reads, for the OpenAPI contract — the one
 * part of a request no other artefact reveals.
 */
export interface RouteQueryParam {
  name: string;
  required: boolean;
  /** One line, shown in the generated document. */
  description: string;
  /** The value after standard OpenAPI query deserialization. */
  type?: 'string' | 'integer';
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  example?: string | number;
}

export interface RouteDefinition {
  method: HttpMethod;
  /** Framework-neutral path with `:name` params, e.g. `/api/dash/users/:id`. */
  path: string;
  handler: Handler;
  preAuth: PreAuthPolicy;
  auth: AuthPolicy;
  /**
   * Does the handler call `verifyTurnstileRequest`? Separate from `auth`
   * because a failed captcha is a 403 on `public` and `session` routes alike,
   * and folding it in would make a captcha-guarded route indistinguishable from
   * one that checks a grant.
   */
  captcha: boolean;
  /** Does the handler itself invoke the fail-closed rate limiter? */
  handlerRateLimit: boolean;
  body: BodyPolicy;
  response: ResponsePolicy;
  query?: readonly RouteQueryParam[];
  /**
   * Raises this request's idle timeout above the server-wide ceiling. Optional
   * because it is a capacity knob, not a security control.
   */
  timeoutSeconds?: number;
  /**
   * Raises this route's JSON body ceiling above `MAX_JSON_BODY_BYTES`, so the
   * ceiling stays a per-route contract. Only meaningful with `body: 'json'`.
   */
  maxJsonBodyBytes?: number;
  /**
   * `false` while the build-time feature behind the route is off: the row is
   * then neither registered nor published, so the path answers the
   * unknown-path 404 like a switched-off Better Auth endpoint. Omitted means
   * always on.
   */
  enabled?: boolean;
  /**
   * Can answer 401 `REAUTH_REQUIRED`: the handler asks for the
   * re-authentication window, through `requirePermission`'s `reauth` or a
   * function that reaches `requireReauthWindow`.
   * `tests/unit/route-auth-flags.test.ts` holds each route to its handler.
   */
  reauth: boolean;
  /** Checks the account password, so a locked account answers 429. */
  checksPassword: boolean;
}

/**
 * The policy half of a route — what the document is built from — and the key
 * its handler was wrapped with, which the build holds to `method` and `path`.
 */
export type RouteManifestEntry = Omit<
  RouteDefinition,
  'handler' | 'timeoutSeconds' | 'enabled'
> & { handlerKey?: Handler['routeKey'] };

/** One sub-path of a prefix, with the methods that path actually answers. */
export interface RoutePrefixPath {
  /** Relative to the prefix, e.g. `/sign-out`. */
  path: string;
  methods: readonly HttpMethod[];
  /**
   * The per-IP admission budget for this path, overriding `PRE_AUTH_LIMIT`.
   * Required, like every policy on `RouteDefinition`: a session read on every
   * dashboard navigation and a credential submission need budgets an order of
   * magnitude apart.
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
 * Auth, which takes the raw `Request` and so is not a `RouteDefinition`. It
 * still feeds the lookups, or the 405 boundary would answer 404 for a wrong
 * method under `/api/auth/*`.
 */
export interface RoutePrefix {
  /** Prefix WITHOUT the trailing wildcard, e.g. `/api/auth`. */
  prefix: string;
  /**
   * What the prefix handler may read, for the WHOLE prefix: the ceiling is
   * decided at `onRequest`, before the router has matched a sub-path. Sub-paths
   * that disagreed would need this moved down to `RoutePrefixPath` and a
   * sub-path lookup at that boundary.
   */
  body: BodyPolicy;
  /**
   * The exact sub-paths served, each with its own methods, so neither an
   * unknown sub-path nor an unserved method is advertised in `Allow` or in the
   * document.
   */
  paths: readonly RoutePrefixPath[];
}

export function toManifest(
  routes: readonly RouteDefinition[]
): RouteManifestEntry[] {
  return routes.map(
    ({ handler, timeoutSeconds: _timeout, enabled: _enabled, ...entry }) =>
      handler.routeKey === undefined
        ? entry
        : { ...entry, handlerKey: handler.routeKey }
  );
}

const DEVELOPMENT_ONLY_PREFIXES = ['/api/dev/'] as const;

/**
 * Is this path development-only — both unregistered and unpublished outside
 * development? One predicate for both decisions, so a future `/api/dev/*` route
 * cannot be registered in production by a handler that forgets its own
 * `NODE_ENV` check.
 *
 * Also read by the document's consistency check, so a schema for an
 * unpublished route is not reported as a leftover.
 */
export function isDevelopmentOnlyPath(path: string): boolean {
  return DEVELOPMENT_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * The routes THIS PROCESS serves: what `app.ts` registers and answers 404/405
 * and OPTIONS from, each handler held to its response contract outside
 * production (`withResponseCheck`). `ROUTES` stays the complete table, because
 * `scripts/build-openapi.ts` builds the deployed document from it and
 * `scripts/find-unused-files.ts` reads it statically.
 */
export function toRegisteredRoutes(
  routes: readonly RouteDefinition[],
  development = process.env.NODE_ENV === 'development',
  check = responseCheckMode()
): readonly RouteDefinition[] {
  return routes
    .filter(
      (route) =>
        route.enabled !== false &&
        (development || !isDevelopmentOnlyPath(route.path))
    )
    .map((route) =>
      check === null
        ? route
        : { ...route, handler: withResponseCheck(route.handler, check) }
    );
}

/**
 * `production` is a parameter because the build generates the DEPLOYED
 * document on a machine that is not the deployment, and forcing
 * `NODE_ENV=production` there would also trip `assertEnv` into demanding
 * production secrets to write a static file.
 */
export function toPublishedManifest(
  routes: readonly RouteDefinition[],
  production = process.env.NODE_ENV === 'production'
): RouteManifestEntry[] {
  return toManifest(
    routes.filter(
      (route) =>
        route.enabled !== false &&
        (!production || !isDevelopmentOnlyPath(route.path))
    )
  );
}

/**
 * The rows `enabled: false` withholds from both lists above. The document's
 * consistency check reads them, so a table entry for a switched-off route is
 * not reported as a leftover.
 */
export function toWithheldManifest(
  routes: readonly RouteDefinition[]
): RouteManifestEntry[] {
  return toManifest(routes.filter((route) => route.enabled === false));
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
  // eslint-disable-next-line security/detect-non-literal-regexp -- `path` comes from the route table in routes.ts, never from a request, and every non-param segment is escaped above
  return new RegExp(`^${source}$`);
}

/**
 * Answers "which methods does this pathname actually answer?" for the
 * 404-vs-405 boundary and route-aware OPTIONS. Elysia reports a wrong method on
 * a registered path and an unknown path both as `NOT_FOUND`, so the answer has
 * to come from here.
 *
 * `HEAD` is derived from `GET` for both kinds of registration: Elysia
 * dispatches HEAD to the matching GET route, and `betterAuthServes` answers
 * HEAD from the GET entry. The two branches must keep agreeing.
 */
export function createRouteLookup(
  routes: readonly RouteDefinition[],
  prefixes: readonly RoutePrefix[] = []
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
 * The ceiling follows the POLICY the table declares, so a caller cannot buy the
 * multipart allowance by writing `multipart/form-data` on a JSON-only endpoint.
 * A path that matches nothing takes the smaller default: it is about to 404.
 *
 * The LARGEST ceiling wins when two methods on one path disagree: this bound is
 * coarse by construction, the reader in `withBodyPolicy` applies the exact
 * per-route value again, and taking the smallest would refuse a request the
 * route it belongs to accepts.
 */
export function createBodyCeilingLookup(
  routes: readonly RouteDefinition[],
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
 * only from `createRouteLookup`, which knows whether it is served.
 */
export function allowHeader(methods: ReadonlySet<AdvertisedMethod>): string {
  const advertised = new Set<string>(methods);
  advertised.add('OPTIONS');
  return [...advertised].join(', ');
}
