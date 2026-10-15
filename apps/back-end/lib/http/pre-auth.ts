import type { HandlerRequestMeta } from './contract';

import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

// Generous enough that a shared NAT egress is not punished, tight enough to cap
// unauthenticated abuse of the session layer.
export const PRE_AUTH_LIMIT = 120;
const PRE_AUTH_WINDOW_S = 60;
const PRE_AUTH_SURFACE_SEGMENTS = 2;
const PRE_AUTH_SEGMENT_MAX = 40;

/**
 * The limiter scope for a binding: two segments after `/api`
 * (`/api/dash/users/<id>` → `preauth.dash.users`), so unrelated surfaces
 * behind one NAT do not throttle each other while dynamic ids cannot explode
 * the keyspace.
 */
export function preAuthScope(pathname: string): string {
  return scopeFrom(pathname, PRE_AUTH_SURFACE_SEGMENTS);
}

/** How deep `allowlistedPathScope` may go; a bound on the key, not a policy. */
const PRE_AUTH_PATH_SEGMENTS = 8;

/**
 * The scope for ONE path on a wildcard prefix's allowlist — the whole path, so
 * a budget declared per path in `lib/auth/allowed-paths.ts` is also counted
 * per path.
 *
 * Only safe because the caller has matched the path against that compile-time
 * list, so no client input can widen the keyspace. Everything outside it shares
 * `UNKNOWN_PREFIX_SCOPE`.
 */
export function allowlistedPathScope(pathname: string): string {
  return scopeFrom(pathname, PRE_AUTH_PATH_SEGMENTS);
}

function scopeFrom(pathname: string, maxSegments: number): string {
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .filter((segment) => segment !== 'api')
    .slice(0, maxSegments)
    .map((segment) => segment.slice(0, PRE_AUTH_SEGMENT_MAX));
  return segments.length > 0 ? `preauth.${segments.join('.')}` : 'preauth.root';
}

interface PreAuthLimitOptions {
  /**
   * Overrides `PRE_AUTH_LIMIT` for one path — the Better Auth prefix's
   * per-path budgets (`RoutePrefixPath.preAuthLimit`), routed through here so
   * auth admission stays in one place.
   */
  limit?: number;
  /**
   * Replaces the path-derived scope with a FIXED one. A caller serving a
   * wildcard must pass one for everything outside its allowlist: a scope built
   * from an unbounded path mints a new limiter key, and a `rate_limit` row,
   * per invented path.
   */
  scope?: string;
}

/**
 * Coarse per-IP admission, run before the handler so unauthenticated traffic
 * cannot hammer session lookup.
 *
 * Fail-closed: letting requests through on a degraded limiter store would strip
 * the protection it exists for. Takes only the request head, so it runs before
 * the body is parsed.
 */
export function enforcePreAuthIpLimit(
  ctx: Pick<HandlerRequestMeta, 'apiPath' | 'headers'>,
  options: PreAuthLimitOptions = {}
): Promise<void> {
  return enforceRateLimit({
    scope: options.scope ?? preAuthScope(ctx.apiPath),
    identifier: ipIdentifier(ctx.headers),
    limit: options.limit ?? PRE_AUTH_LIMIT,
    window: PRE_AUTH_WINDOW_S,
    failClosed: true,
  });
}

/**
 * The single bucket every unrecognised path under a wildcard prefix shares, so
 * path rotation multiplies neither the budget nor the keyspace.
 */
export const UNKNOWN_PREFIX_SCOPE = 'preauth.auth.unknown';
