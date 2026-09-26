import type {
  AccessScope,
  AllScopedAction,
  DashboardPage,
  PermissionAction,
} from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, sessions, users } from '@/db/schema';

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
import { assertLiveSession } from '@/lib/auth/session/live';

import { getUserPermissions, sanitizePermissions } from './utils';

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

const SCOPED_ACTIONS = new Set<PermissionAction>(
  Object.keys(OWN_ACTION_MAP) as PermissionAction[]
);
const READ_ACTIONS = new Set<PermissionAction>(['view', 'viewOwn']);

function hasSessionCookieCache(headers: Headers): boolean {
  return /(?:^|;\s*)better-auth\.session_data=/.test(
    headers.get('cookie') ?? ''
  );
}

function loginRequired(): CustomError {
  return new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
}

export function insufficientPermissions(): CustomError {
  return new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);
}

/** Better Auth's view of the caller, possibly from the cookie cache. */
export async function authenticatedSession(
  headers: Headers
): Promise<{ session: AuthSession; userId: EntityID }> {
  const session = await auth.api.getSession({ headers });
  const userId = validID(session?.user.id);
  if (!session || !userId) throw loginRequired();
  return { session, userId };
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

  // Write/mutation actions always verify from DB; read actions use cache
  const shouldForceDB =
    forceDB || !READ_ACTIONS.has(action) || !hasSessionCookieCache(headers);

  if (shouldForceDB) {
    // The session ROW is verified here, not just the user and role:
    // `getSession` may answer from Better Auth's cookie cache, which stays
    // valid after the row behind it is deleted, and every revocation deletes
    // rows. An active user with an active role passes every other check.
    const sessionId = sessionIdOf(session);

    // Single query: session + user + role + permissions in one round-trip.
    const rows = await db
      .select({
        roleId: users.roleId,
        roleName: roles.roleName,
        roleScope: roles.scope,
        roleIsActive: roles.isActive,
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
    if (!sessionRow) throw loginRequired();

    const roleId = sessionRow.roleId;
    if (!roleId) throw insufficientPermissions();

    if (sessionRow.roleIsActive === false) throw insufficientPermissions();

    const rolePerms = rows.flatMap((r) =>
      r.pageName == null
        ? []
        : [{ pageName: r.pageName, permissions: r.pagePermissions }]
    );

    const permissions = sanitizePermissions(rolePerms);

    const { allowed, scope } = resolveActionScope(
      permissions,
      resource,
      action
    );
    if (!allowed && throwError) throw insufficientPermissions();

    return {
      allowed,
      scope,
      source: 'database' as const,
      session,
      userId,
      sessionId,
      roleId,
      permissions,
    };
  }

  // Read routes accept Better Auth's configured cookie-cache revocation window.
  // Sensitive mutations take the forceDB branch above.
  const sessionId = sessionIdOf(session);

  const roleId = validID(session.user.roleId) ?? null;

  if (!roleId) throw insufficientPermissions();

  const permissions = await getUserPermissions({
    session: session.session,
    roleId,
    forceDB: false,
  });

  const { allowed, scope } = resolveActionScope(permissions, resource, action);
  if (!allowed && throwError) throw insufficientPermissions();

  return {
    allowed,
    scope,
    source: 'cache' as const,
    session,
    userId,
    sessionId,
    roleId,
    permissions,
  };
}

/**
 * Checks several permissions in one call.
 */
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

  const hasWriteAction = checks.some((c) => !READ_ACTIONS.has(c.action));
  const shouldForceDB =
    forceDB || hasWriteAction || !hasSessionCookieCache(headers);

  let roleId: EntityID | null = validID(session.user.roleId) ?? null;

  const cachedSessionId = sessionIdOf(session);
  const sessionId = shouldForceDB
    ? await assertLiveSession(cachedSessionId, userId)
    : cachedSessionId;

  if (shouldForceDB) {
    const [userData] = await db
      .select({
        roleId: users.roleId,
        roleName: roles.roleName,
        roleScope: roles.scope,
        roleIsActive: roles.isActive,
      })
      .from(users)
      .leftJoin(roles, eq(users.roleId, roles.id))
      .where(
        and(
          eq(users.id, userId),
          isNull(users.deletedAt),
          eq(users.isActive, true)
        )
      );

    if (!userData) throw loginRequired();
    roleId = userData.roleId;

    if (!roleId) throw insufficientPermissions();

    if (!userData.roleIsActive) throw insufficientPermissions();
  }

  if (!roleId) throw insufficientPermissions();

  const allPermissions = await getUserPermissions({
    roleId,
    session: shouldForceDB ? null : session.session,
    forceDB: shouldForceDB,
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
