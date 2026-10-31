import type { HandlerCookie } from '@/lib/http/contract';
import type { EntityID } from '@app/shared/types';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, sessions, users } from '@/db/schema';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import { deleteSessionCookie, parseCookies } from 'better-auth/cookies';
import { kAPIErrorHeaderSymbol } from 'better-call';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';
import { validID } from '@app/shared/utils';

import {
  parseSetCookieHeaders,
  queueResponseCookies,
} from '@/lib/http/cookies';

import { logSanitized } from '@/utils/log';

import { auth } from '..';
import { liveSessionCondition } from './live';

export type AuthSession = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;

function loginRequired(): CustomError {
  return new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
}

/**
 * The expiries `getSession` set before throwing its 401 (the row deleted during
 * its daily slide). better-call keeps them off `headers`.
 */
function refusedReadCookies(error: unknown): HandlerCookie[] | undefined {
  if (!isAPIError(error) || error.statusCode !== HTTP_STATUS.UNAUTHORIZED)
    return undefined;
  const set: unknown = Reflect.get(error, kAPIErrorHeaderSymbol);
  return set instanceof Headers
    ? parseSetCookieHeaders(set.getSetCookie())
    : [];
}

/**
 * Better Auth's view of the caller, possibly from the cookie cache. The cookies
 * the read sets (a re-minted cache, its expiry, the sliding refresh) are queued
 * for the response, the 401 below included.
 */
export async function authenticatedSession(
  headers: Headers
): Promise<{ session: AuthSession; userId: EntityID }> {
  let read;
  try {
    read = await auth.api.getSession({ headers, returnHeaders: true });
  } catch (error) {
    const expiries = refusedReadCookies(error);
    if (!expiries) throw error;
    queueResponseCookies(headers, expiries);
    throw loginRequired();
  }
  queueResponseCookies(
    headers,
    parseSetCookieHeaders(read.headers.getSetCookie())
  );
  const session = read.response;
  const userId = validID(session?.user.id);
  if (!session || !userId) throw loginRequired();
  return { session, userId };
}

// Uncached, so a revoked session clears its cookies. Non-fatal: a failure leaves
// the cookies as they were, and the caller's answer stands.
export async function refreshSessionCookies(
  headers: Headers
): Promise<HandlerCookie[] | undefined> {
  let cookies: HandlerCookie[];
  try {
    const refreshed = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    cookies = parseSetCookieHeaders(refreshed.headers.getSetCookie());
  } catch (e) {
    const expiries = refusedReadCookies(e);
    if (!expiries) {
      logSanitized('error', { msg: 'session.cookieRefresh failed', error: e });
      return undefined;
    }
    cookies = expiries;
  }
  return cookies.length > 0 ? cookies : undefined;
}

const expireSessionCookies = createAuthMiddleware(async (ctx) => {
  deleteSessionCookie(ctx);
  return ctx.responseHeaders.getSetCookie();
});

/**
 * The 401 for a session the database refused, with Better Auth's sign-out
 * expiries queued. Not a refresh: `getSession` knows nothing of `is_active`,
 * so it would re-mint the cache of a suspended user.
 */
async function sessionRefused(headers: Headers): Promise<CustomError> {
  // How the library invokes its hooks; the input type omits `context`.
  const input = { headers, context: await auth.$context };
  const expiries = await expireSessionCookies(input);
  queueResponseCookies(headers, parseSetCookieHeaders(expiries));
  return loginRequired();
}

export async function queueRefreshedSessionCookies(
  headers: Headers
): Promise<void> {
  queueResponseCookies(headers, (await refreshSessionCookies(headers)) ?? []);
}

export function sessionIdOf(session: AuthSession): EntityID {
  const sessionId = validID(session.session.id);
  if (!sessionId) throw loginRequired();
  return sessionId;
}

/**
 * Whether the request names a session token at all; without one `getSession`
 * returns null before any read. The library looks the cookie up by its exact
 * name, so a substring test can only say yes wrongly, never no.
 */
export async function presentsSessionToken(headers: Headers): Promise<boolean> {
  const context = await auth.$context;
  const { name } = context.authCookies.sessionToken;
  return headers.get('cookie')?.includes(name) ?? false;
}

/**
 * Whether `getSession` may have answered from the cookie cache. The name is the
 * library's own, so it carries `__Secure-` under an https origin, and a large
 * value arrives as `.0`, `.1`… chunks.
 */
export async function hasSessionCookieCache(
  headers: Headers
): Promise<boolean> {
  const header = headers.get('cookie');
  if (!header) return false;

  const context = await auth.$context;
  const name = context.createAuthCookie('session_data').name;
  const chunkPrefix = `${name}.`;
  return parseCookies(header)
    .keys()
    .some(
      (cookie) =>
        cookie === name ||
        (cookie.startsWith(chunkPrefix) &&
          isChunkIndex(cookie.slice(chunkPrefix.length)))
    );
}

function isChunkIndex(suffix: string): boolean {
  const index = Number(suffix);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === suffix;
}

/**
 * The session ROW, read with its user's liveness and its grants: `getSession`
 * may answer from Better Auth's cookie cache, which outlives a deleted row, and
 * every revocation deletes rows. One read, so a session route whose handler
 * then checks a grant verifies the row once.
 */
export async function readLiveSession(
  headers: Headers,
  session: AuthSession,
  userId: EntityID
) {
  const sessionId = sessionIdOf(session);

  const rows = await db
    .select({
      metadata: sessions.metadata,
      roleId: users.roleId,
      roleIsActive: roles.isActive,
      roleName: roles.roleName,
      roleScope: roles.scope,
      pageName: rolePermissions.pageName,
      pagePermissions: rolePermissions.permissions,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .leftJoin(roles, eq(users.roleId, roles.id))
    .leftJoin(rolePermissions, eq(roles.id, rolePermissions.roleId))
    .where(liveSessionCondition(sessionId, userId));

  const [sessionRow] = rows;
  if (!sessionRow) throw await sessionRefused(headers);
  return { sessionId, sessionRow, rows };
}

export type LiveSession = Awaited<ReturnType<typeof readLiveSession>>;
