/**
 * Gives a "do not remember" session the `cookieCache.maxAge` read cache a
 * remembered one gets: Better Auth mints theirs with a 60 s payload and never
 * re-mints it from `/get-session`.
 *
 * ⚠️ The cache cookie this mints outlives the browser session `session_token`
 * is bound to. That grants nothing only because `getSession` returns null
 * without a signed token before it reads the cache; re-check on an upgrade.
 * Row and token are untouched, so the sliding refresh still skips these.
 */
import type { HookContext } from '../context';
import type { BetterAuthPlugin } from 'better-auth';

import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import {
  getChunkedCookie,
  parseSetCookieHeader,
  setCookieCache,
} from 'better-auth/cookies';

type CachedSession = Parameters<typeof setCookieCache>[1];

/** `sessionScoped` is the library's "do not remember" mint: no `Max-Age`. */
type PendingCache = 'lasting' | 'sessionScoped' | 'expired' | null;

function namesCache(entry: string, cacheName: string): boolean {
  const cookie = entry.split('=', 1)[0] ?? '';
  return cookie === cacheName || cookie.startsWith(`${cacheName}.`);
}

function entryState(entry: string, cacheName: string): PendingCache {
  if (!namesCache(entry, cacheName)) return null;
  const [attributes] = parseSetCookieHeader(entry).values();
  const maxAge = attributes?.['max-age'];
  if (maxAge === 0 || !attributes?.value) return 'expired';
  return maxAge === undefined ? 'sessionScoped' : 'lasting';
}

/** The last `Set-Cookie` the response holds for the cache, chunks included. */
function pendingCache(ctx: HookContext, cacheName: string): PendingCache {
  const entries = ctx.context.responseHeaders?.getSetCookie() ?? [];
  return (
    entries
      .map((entry) => entryState(entry, cacheName))
      .findLast((state) => state !== null) ?? null
  );
}

/**
 * Replaces, not appends: the response would otherwise carry both mints, and
 * the browser keeps whichever it applies last.
 */
async function remintCache(
  ctx: HookContext,
  cacheName: string,
  session: CachedSession
): Promise<void> {
  const headers = ctx.context.responseHeaders;
  if (headers) {
    const kept = headers
      .getSetCookie()
      .filter((entry) => !namesCache(entry, cacheName));
    headers.delete('set-cookie');
    for (const entry of kept) headers.append('set-cookie', entry);
  }
  await setCookieCache(ctx, session, false);
}

async function isDontRemember(ctx: HookContext): Promise<boolean> {
  const marker = ctx.context.authCookies.dontRememberToken.name;
  return Boolean(await ctx.getSignedCookie(marker, ctx.context.secret));
}

/**
 * On `/get-session` the library answered from the cache unless it expired the
 * cookie, was told to skip it, or the request carried none.
 */
function answeredFromCache(
  ctx: HookContext,
  cacheName: string,
  pending: PendingCache
): boolean {
  return (
    pending === null &&
    !ctx.query?.disableCookieCache &&
    getChunkedCookie(ctx, cacheName) !== null
  );
}

async function extendDontRememberCache(ctx: HookContext): Promise<void> {
  const { returned, newSession, session } = ctx.context;
  if (isAPIError(returned)) return;

  const cacheName = ctx.context.authCookies.sessionData.name;
  const pending = pendingCache(ctx, cacheName);

  if (pending === 'sessionScoped') {
    if (newSession) await remintCache(ctx, cacheName, newSession);
    return;
  }

  if (
    !returned ||
    !session ||
    pending === 'lasting' ||
    ctx.path !== '/get-session' ||
    answeredFromCache(ctx, cacheName, pending)
  )
    return;
  if (await isDontRemember(ctx)) await remintCache(ctx, cacheName, session);
}

/**
 * A hook rather than a patch: it runs for the HTTP route and for direct
 * `auth.api.getSession` calls alike. Endpoints that call `getSessionFromCtx`
 * bypass hooks, so their reads keep the library's behaviour.
 */
export const sessionCookieCache = () =>
  ({
    id: 'session-cookie-cache',
    hooks: {
      after: [
        {
          matcher: (context) =>
            context.path === '/get-session' ||
            context.context.newSession !== null,
          handler: createAuthMiddleware(extendDontRememberCache),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
