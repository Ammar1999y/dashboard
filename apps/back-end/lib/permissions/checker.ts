import type { HandlerCookie } from '@/lib/http/contract';
import type {
  DashboardPage,
  PermissionAction,
  SessionMetadata,
} from '@app/shared/permissions/constants';
import type { PermissionRows } from '@app/shared/permissions/matrix';
import type { ActorPermissions } from '@app/shared/permissions/scope';
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
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';
import {
  permissionsEqual,
  sanitizePermissions,
} from '@app/shared/permissions/matrix';
import { resolveActionScope } from '@app/shared/permissions/scope';
import { validID } from '@app/shared/utils';

import { auth } from '@/lib/auth';
import { liveSessionCondition } from '@/lib/auth/session/live';
import {
  parseSetCookieHeaders,
  queueResponseCookies,
} from '@/lib/http/cookies';

import { logSanitized } from '@/utils/log';

import { resyncUserSessions } from './session-refresh';

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

const READ_ACTIONS = new Set<PermissionAction>(['view', 'viewOwn']);

function loginRequired(): CustomError {
  return new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
}

export function insufficientPermissions(): CustomError {
  return new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);
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

async function queueRefreshedSessionCookies(headers: Headers): Promise<void> {
  queueResponseCookies(headers, (await refreshSessionCookies(headers)) ?? []);
}

function sessionIdOf(session: AuthSession): EntityID {
  const sessionId = validID(session.session.id);
  if (!sessionId) throw loginRequired();
  return sessionId;
}

interface Grants {
  source: 'database' | 'cache';
  sessionId: EntityID;
  roleId: EntityID;
  permissions: ActorPermissions;
}

/**
 * Whether `getSession` may have answered from the cookie cache. The name is the
 * library's own, so it carries `__Secure-` under an https origin, and a large
 * value arrives as `.0`, `.1`… chunks.
 */
async function hasSessionCookieCache(headers: Headers): Promise<boolean> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cachedPermissionRows(cached: Record<string, unknown>): PermissionRows {
  return Object.entries(cached).map(([pageName, permissions]) => ({
    pageName,
    permissions,
  }));
}

function sanitizeCachedPermissions(
  cached: Record<string, unknown>
): ActorPermissions {
  return sanitizePermissions(cachedPermissionRows(cached));
}

async function getUserPermissions({
  roleId,
  session,
}: {
  roleId: EntityID;
  session: { metadata?: unknown };
}): Promise<ActorPermissions> {
  const { metadata } = session;
  if (isRecord(metadata) && isRecord(metadata.permissions))
    return sanitizeCachedPermissions(metadata.permissions);

  const roleData = await db.query.roles.findFirst({
    where: (rolesTable, { eq, and }) =>
      and(eq(rolesTable.id, roleId), eq(rolesTable.isActive, true)),
    columns: {},
    with: {
      rolePermissions: {
        columns: { pageName: true, permissions: true },
      },
    },
  });

  if (!roleData) return {};
  return sanitizePermissions(roleData.rolePermissions);
}

/**
 * Read routes accept Better Auth's cookie-cache window: a grant narrowed or a
 * session revoked meanwhile is honoured until `cookieCache.maxAge`.
 */
async function cachedGrants(session: AuthSession): Promise<Grants> {
  const sessionId = sessionIdOf(session);
  const roleId = validID(session.user.roleId);
  if (!roleId) throw insufficientPermissions();

  const permissions = await getUserPermissions({
    roleId,
    session: session.session,
  });
  return { source: 'cache', sessionId, roleId, permissions };
}

/**
 * Whether a session snapshot (the cookie cache's, or the row's) disagrees with
 * the database's grants. A sign-in racing a role edit can persist a pre-edit
 * snapshot that no refresh reaches.
 */
function snapshotDrifted(
  snapshot: { metadata: unknown; userRoleId: unknown },
  live: SessionMetadata & { roleId: EntityID; rows: PermissionRows }
): boolean {
  const { metadata } = snapshot;
  if (!isRecord(metadata) || !isRecord(metadata.permissions)) return true;
  return (
    validID(snapshot.userRoleId) !== live.roleId ||
    metadata.roleId !== live.roleId ||
    metadata.roleName !== live.roleName ||
    metadata.roleScope !== live.roleScope ||
    !permissionsEqual(cachedPermissionRows(metadata.permissions), live.rows)
  );
}

/** Best-effort: this request is judged by the live grants either way. */
async function resyncSession(headers: Headers, userId: EntityID) {
  try {
    await resyncUserSessions(userId);
    await queueRefreshedSessionCookies(headers);
  } catch (error) {
    logSanitized('error', { msg: 'session.resync failed', error });
  }
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

type LiveSession = Awaited<ReturnType<typeof readLiveSession>>;

/**
 * The caller's grants as the database holds them now. A stale row is
 * rewritten; a cookie cache stale behind a current row is only re-minted.
 */
async function liveGrants(
  headers: Headers,
  session: AuthSession,
  userId: EntityID,
  read?: LiveSession
): Promise<Grants> {
  const { sessionId, sessionRow, rows } =
    read ?? (await readLiveSession(headers, session, userId));

  const roleId = sessionRow.roleId;
  if (!roleId || !sessionRow.roleIsActive) throw insufficientPermissions();

  const permissionRows = rows.flatMap((r) =>
    r.pageName == null
      ? []
      : [{ pageName: r.pageName, permissions: r.pagePermissions }]
  );

  const live = {
    roleId,
    roleName: sessionRow.roleName,
    roleScope: sessionRow.roleScope,
    rows: permissionRows,
  };
  // A role edit refreshes the rows, not the cookies already issued.
  if (
    snapshotDrifted({ metadata: sessionRow.metadata, userRoleId: roleId }, live)
  )
    await resyncSession(headers, userId);
  else if (
    snapshotDrifted(
      { metadata: session.session.metadata, userRoleId: session.user.roleId },
      live
    )
  )
    await queueRefreshedSessionCookies(headers);

  const permissions = sanitizePermissions(permissionRows);
  return { source: 'database', sessionId, roleId, permissions };
}

async function resolveGrants(params: {
  headers: Headers;
  session: AuthSession;
  userId: EntityID;
  actions: readonly PermissionAction[];
  forceDB: boolean;
  live?: LiveSession;
}): Promise<Grants> {
  const cacheable =
    !params.forceDB &&
    params.actions.every((action) => READ_ACTIONS.has(action)) &&
    (await hasSessionCookieCache(params.headers));

  return cacheable
    ? cachedGrants(params.session)
    : liveGrants(params.headers, params.session, params.userId, params.live);
}

export async function checkUserPermission(params: {
  headers: Headers;
  resource: DashboardPage;
  action: PermissionAction;
  forceDB?: boolean;
  throwError?: boolean;
}) {
  const {
    headers,
    resource,
    action,
    forceDB = false,
    throwError = true,
  } = params;

  const { session, userId } = await authenticatedSession(headers);
  const { source, sessionId, roleId, permissions } = await resolveGrants({
    headers,
    session,
    userId,
    actions: [action],
    forceDB,
  });

  const { allowed, scope } = resolveActionScope(permissions, resource, action);
  if (!allowed && throwError) throw insufficientPermissions();

  return {
    allowed,
    scope,
    source,
    session,
    userId,
    sessionId,
    roleId,
    permissions,
  };
}

export async function checkMultiplePermissions(params: {
  headers: Headers;
  checks: Array<{ resource: DashboardPage; action: PermissionAction }>;
  forceDB?: boolean;
  /** The caller's session, and its row when already read for this request. */
  signedIn?: { session: AuthSession; userId: EntityID; live?: LiveSession };
}): Promise<{
  permissions: Record<string, boolean>;
  session: AuthSession;
  userId: EntityID;
  sessionId: EntityID;
}> {
  const { headers, checks, forceDB = false } = params;

  const { session, userId, live }: NonNullable<typeof params.signedIn> =
    params.signedIn ?? (await authenticatedSession(headers));
  const { sessionId, permissions: allPermissions } = await resolveGrants({
    headers,
    session,
    userId,
    actions: checks.map((check) => check.action),
    forceDB,
    live,
  });

  const permissions = checks.reduce(
    (acc, { resource, action }) => {
      acc[`${resource}.${action}`] = resolveActionScope(
        allPermissions,
        resource,
        action
      ).allowed;
      return acc;
    },
    {} as Record<string, boolean>
  );

  return {
    permissions,
    session,
    userId,
    sessionId,
  };
}
