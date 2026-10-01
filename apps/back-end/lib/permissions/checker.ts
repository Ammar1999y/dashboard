import type { PermissionRows } from './matrix';
import type { HandlerCookie } from '@/lib/http/contract';
import type {
  AccessScope,
  AllScopedAction,
  DashboardPage,
  PermissionAction,
  PermissionObject,
  SessionMetadata,
} from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, sessions, users } from '@/db/schema';
import { parseCookies } from 'better-auth/cookies';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_LOGIN_REQUIRED,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import {
  OWN_ACTION_MAP,
  SUPERSEDING_ACTION,
} from '@app/shared/permissions/constants';
import { validID } from '@app/shared/utils';

import { auth } from '@/lib/auth';
import {
  parseSetCookieHeaders,
  queueResponseCookies,
} from '@/lib/http/cookies';

import { logSanitized } from '@/utils/log';

import { permissionsEqual, sanitizePermissions } from './matrix';
import { resyncUserSessions } from './session-refresh';

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export type ActorPermissions = Partial<PermissionObject>;

const SCOPED_ACTIONS = new Set<PermissionAction>(
  Object.keys(OWN_ACTION_MAP) as PermissionAction[]
);
const READ_ACTIONS = new Set<PermissionAction>(['view', 'viewOwn']);

function loginRequired(): CustomError {
  return new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
}

export function insufficientPermissions(): CustomError {
  return new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);
}

/**
 * Better Auth's view of the caller, possibly from the cookie cache. The cookies
 * the read sets (a re-minted cache, its expiry, the sliding refresh) are queued
 * for the response, the 401 below included.
 */
export async function authenticatedSession(
  headers: Headers
): Promise<{ session: AuthSession; userId: EntityID }> {
  const { headers: setCookies, response: session } = await auth.api.getSession({
    headers,
    returnHeaders: true,
  });
  queueResponseCookies(
    headers,
    parseSetCookieHeaders(setCookies.getSetCookie())
  );
  const userId = validID(session?.user.id);
  if (!session || !userId) throw loginRequired();
  return { session, userId };
}

// Uncached, so a revoked session clears its cookies. Non-fatal: a failure leaves
// the cookies as they were, and the caller's answer stands.
export async function refreshSessionCookies(
  headers: Headers
): Promise<HandlerCookie[] | undefined> {
  try {
    const refreshed = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    const cookies = parseSetCookieHeaders(refreshed.headers.getSetCookie());
    return cookies.length > 0 ? cookies : undefined;
  } catch (e) {
    logSanitized('error', { msg: 'session.cookieRefresh failed', error: e });
    return undefined;
  }
}

async function queueRefreshedSessionCookies(headers: Headers): Promise<void> {
  queueResponseCookies(headers, (await refreshSessionCookies(headers)) ?? []);
}

function sessionIdOf(session: AuthSession): EntityID {
  const sessionId = validID(session.session.id);
  if (!sessionId) throw loginRequired();
  return sessionId;
}

/**
 * Resolve allowed/scope for a given action against a permissions matrix.
 *
 * - An all-scoped action (`view`/`edit`/`delete`): the unrestricted grant first,
 *   then the `Own` variant with `scope: 'own'`.
 * - An own-scoped action (`viewOwn`/`editOwn`/`deleteOwn`): the superseding
 *   unrestricted grant first, then the own grant itself.
 * - Anything else: exact match only.
 *
 * Exported so it can be tested directly: a bug here is an authorization bypass,
 * and reached only through `checkUserPermission` every case in its matrix costs
 * a session and a database round trip. See
 * `tests/unit/permission-scope.test.ts`.
 */
export function resolveActionScope(
  permissions:
    | Record<string, Record<string, boolean>>
    | Partial<Record<DashboardPage, Record<PermissionAction, boolean>>>,
  resource: DashboardPage,
  action: PermissionAction
): { allowed: boolean; scope: AccessScope | null } {
  const pagePerms = permissions?.[resource];

  // An own-scoped action asked for DIRECTLY, handled first because the generic
  // path below answers both of its cases wrongly: holding `edit` must satisfy
  // `editOwn`, and holding only `editOwn` must answer `scope: 'own'`, never
  // `'all'`.
  const superseding = SUPERSEDING_ACTION[action];
  if (superseding) {
    if (pagePerms?.[superseding] === true)
      return { allowed: true, scope: 'all' };
    if (pagePerms?.[action] === true) return { allowed: true, scope: 'own' };
    return { allowed: false, scope: null };
  }

  if (pagePerms?.[action] === true) return { allowed: true, scope: 'all' };
  if (SCOPED_ACTIONS.has(action)) {
    const ownAction = OWN_ACTION_MAP[action as AllScopedAction];
    if (pagePerms?.[ownAction] === true) return { allowed: true, scope: 'own' };
  }
  return { allowed: false, scope: null };
}

/**
 * `action` on a record `createdBy` owns: the all-scoped grant, or the
 * own-scoped one when the actor created it.
 */
export function holdsActionOn(
  permissions: ActorPermissions,
  resource: DashboardPage,
  action: AllScopedAction,
  createdBy: EntityID | null,
  actorUserId: EntityID
): boolean {
  const { allowed, scope } = resolveActionScope(permissions, resource, action);
  return allowed && (scope === 'all' || createdBy === actorUserId);
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
 * The caller's grants as the database holds them now. The session ROW is
 * verified too: `getSession` may answer from Better Auth's cookie cache, which
 * outlives a deleted row, and every revocation deletes rows. A stale row is
 * rewritten; a cookie cache stale behind a current row is only re-minted.
 */
async function liveGrants(
  headers: Headers,
  session: AuthSession,
  userId: EntityID
): Promise<Grants> {
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
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        gt(sessions.expiresAt, sql`now()`),
        isNull(users.deletedAt),
        eq(users.isActive, true)
      )
    );

  // Covers both "user is gone/inactive" and "this session was revoked".
  const [sessionRow] = rows;
  if (!sessionRow) {
    await queueRefreshedSessionCookies(headers);
    throw loginRequired();
  }

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
}): Promise<Grants> {
  const cacheable =
    !params.forceDB &&
    params.actions.every((action) => READ_ACTIONS.has(action)) &&
    (await hasSessionCookieCache(params.headers));

  return cacheable
    ? cachedGrants(params.session)
    : liveGrants(params.headers, params.session, params.userId);
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
}): Promise<{
  permissions: Record<string, boolean>;
  session: AuthSession;
  userId: EntityID;
  sessionId: EntityID;
}> {
  const { headers, checks, forceDB = false } = params;

  const { session, userId } = await authenticatedSession(headers);
  const { sessionId, permissions: allPermissions } = await resolveGrants({
    headers,
    session,
    userId,
    actions: checks.map((check) => check.action),
    forceDB,
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
