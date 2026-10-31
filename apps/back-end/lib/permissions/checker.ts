import type { AuthSession, LiveSession } from '@/lib/auth/session/read';
import type {
  DashboardPage,
  PermissionAction,
  SessionMetadata,
} from '@app/shared/permissions/constants';
import type { PermissionRows } from '@app/shared/permissions/matrix';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';

import { db } from '@/db';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';
import {
  permissionsEqual,
  sanitizePermissions,
} from '@app/shared/permissions/matrix';
import { resolveActionScope } from '@app/shared/permissions/scope';
import { validID } from '@app/shared/utils';

import {
  authenticatedSession,
  hasSessionCookieCache,
  queueRefreshedSessionCookies,
  readLiveSession,
  sessionIdOf,
} from '@/lib/auth/session/read';

import { logSanitized } from '@/utils/log';

import { resyncUserSessions } from './session-refresh';

const READ_ACTIONS = new Set<PermissionAction>(['view', 'viewOwn']);

export function insufficientPermissions(): CustomError {
  return new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);
}

interface Grants {
  source: 'database' | 'cache';
  sessionId: EntityID;
  roleId: EntityID;
  permissions: ActorPermissions;
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
      : { pageName: r.pageName, permissions: r.pagePermissions }
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
