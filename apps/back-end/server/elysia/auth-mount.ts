/**
 * Better Auth, registered last and as a prefix so every explicit route
 * wins: Elysia resolves static segments before wildcards. `parse: 'none'`
 * keeps the body stream intact — Better Auth reads the request itself.
 *
 * ⚠️ One of only two registrations outside `bind()`, beside the development
 * reference page (`openapi.ts`): Better Auth owns its sub-routing, so its
 * paths are allowlisted data (`RoutePrefix`), not contract entries.
 *
 * **The allowlist is enforced HERE, before `auth.handler` is called.** The
 * `before` hook in `lib/auth/path-policy.ts` enforces it too, but Better Auth
 * runs every plugin's `onRequest` ahead of its hooks, so only this check is
 * upstream of a plugin that matches its endpoints loosely (the captcha plugin
 * would spend an outbound siteverify on an unrouted path). Both stay.
 */
import type { GatedApp } from '@/app';
import type { RoutePrefix, Routing } from '@/lib/http/routing';

import { auth } from '@/lib/auth';
import { betterAuthServes } from '@/lib/auth/allowed-paths';
import { drainQueuedCookies, queueResponseCookies } from '@/lib/http/cookies';
import {
  allowlistedPathScope,
  enforcePreAuthIpLimit,
  UNKNOWN_PREFIX_SCOPE,
} from '@/lib/http/pre-auth';
import { boundedBodyRequest, buildRequestMeta } from '@/lib/http/request';
import { handleApiError, toWebResponse } from '@/lib/http/response';
import {
  checkBetterAuthResponse,
  responseCheckMode,
} from '@/lib/http/response-check';

const responseCheck = responseCheckMode();

/**
 * `auth.handler` on `forwarded`, with any cookie its hooks queued on that
 * request moved to `request`, whose exit delivers the queue.
 */
async function handled(
  forwarded: Request,
  request: Request
): Promise<Response> {
  try {
    return await auth.handler(forwarded);
  } finally {
    if (forwarded !== request)
      queueResponseCookies(
        request.headers,
        drainQueuedCookies(forwarded.headers)
      );
  }
}

export function mountAuthPrefix(
  app: GatedApp,
  prefix: RoutePrefix,
  routing: Routing
): void {
  const handler = async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const subPath = url.pathname.slice(prefix.prefix.length);
    const known = prefix.paths.find((path) => path.path === subPath);
    try {
      // Admission precedes the plugins that perform outbound work. An
      // allowlisted path gets its own key, so a budget declared per path is
      // counted per path; everything else shares ONE fixed key, so rotating
      // `/api/auth/<random>` multiplies neither the budget nor the
      // `rate_limit` keyspace.
      await enforcePreAuthIpLimit(buildRequestMeta(request), {
        limit: known?.preAuthLimit,
        scope: known
          ? allowlistedPathScope(`${prefix.prefix}${known.path}`)
          : UNKNOWN_PREFIX_SCOPE,
      });
      // `routeMiss`, not a plain 404: bindings live under this prefix too
      // (`/api/auth/otp/*`, `/api/auth/forgot-password/*`, ...), and a wrong
      // method on one falls through this wildcard. `routeMiss` still answers
      // 404 for a genuinely unknown sub-path.
      if (!known)
        return (
          routing.canonicalRedirect(url) ?? routing.routeMiss(url.pathname)
        );
      if (!betterAuthServes(subPath, request.method))
        return routing.routeMiss(url.pathname);
      // Better Auth answers 404 for a HEAD on a path it serves for GET, so it
      // is asked the GET; the exit step drops the body. `new Request(url, …)`
      // is a GET.
      const forwarded =
        request.method === 'HEAD'
          ? new Request(request.url, { headers: request.headers })
          : // The counting half of the ceiling the `request` hook declares: a
            // chunked body declares nothing, and Better Auth reads it itself.
            // Same lookup as the hook, so the two halves cannot drift.
            await boundedBodyRequest(
              request,
              routing.lookupBodyCeiling(url.pathname)
            );
      return await checkBetterAuthResponse(
        responseCheck,
        subPath,
        request.method,
        await handled(forwarded, request)
      );
    } catch (error) {
      // Not a binding, so `run()` does not map its errors — the 413
      // `boundedBodyRequest` throws included.
      return toWebResponse(handleApiError(error));
    }
  };

  // Only the methods some sub-path serves; the rest stop at the 405 boundary.
  // Hidden from the generated document, which merges Better Auth's own.
  const config = { parse: 'none', detail: { hide: true } } as const;
  const path = `${prefix.prefix}/*`;
  const methods = new Set(prefix.paths.flatMap((entry) => entry.methods));
  for (const method of methods) {
    app.route(method, path, config, handler);
    if (method === 'GET') app.route('HEAD', path, config, handler);
  }
}
