import type { MockUser } from '../store';
import type {
  DashboardPage,
  PermissionAction,
} from '@app/shared/permissions/constants';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';
import {
  REQUIRE_ROLE_FOR_LOGIN,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';
import {
  sanitizePermissions,
  toPermissionRows,
} from '@app/shared/permissions/matrix';
import {
  assertRowsWithinScope,
  resolveActionScope,
} from '@app/shared/permissions/scope';

import { currentUser, roleOf, roles } from '../store';
import { notFoundError } from './http';
import { requireReauthWindow } from './reauth';

export const insufficientPermissions = () =>
  new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

/** The server's `isActive && roleAllowsLogin(role)`, which sign-in requires. */
export function mayHoldSession(user: MockUser): boolean {
  const role = roleOf(user);
  return user.isActive && (role ? role.isActive : !REQUIRE_ROLE_FOR_LOGIN);
}

/** A role's matrix as the server sanitises it. */
const grantsOf = (matrix: Parameters<typeof toPermissionRows>[0]) =>
  sanitizePermissions(toPermissionRows(matrix));

/**
 * The `metadata` the server keeps on a session: its role and that role's
 * sanitised matrix, which the dashboard reads to decide what to offer. Read
 * live here, where the server reads it at sign-in; an account with no role has
 * none.
 */
export function sessionMetadata(user: MockUser) {
  const role = roleOf(user);
  if (!role || !user.role) return {};
  return {
    roleId: user.roleId,
    roleName: user.role.roleName,
    roleScope: user.role.scope,
    permissions: grantsOf(role.permissions),
  };
}

interface Grants {
  user: MockUser;
  userId: EntityID;
  roleId: EntityID;
  permissions: ActorPermissions;
}

/**
 * The server's `liveGrants`: the caller's grants as the store holds them now.
 * 401 for a missing or deactivated account, 403 for no role or an inactive one.
 */
function liveGrants(): Grants {
  const user = currentUser();
  if (!user || !user.isActive)
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
  const role = roleOf(user);
  if (!user.role || !role?.isActive) throw insufficientPermissions();
  return {
    user,
    userId: user.id,
    roleId: user.role.id,
    permissions: grantsOf(role.permissions),
  };
}

/**
 * The server's `requirePermission`, with the scope it resolves: `'own'` reaches
 * only the records the caller created. `throwError: false` returns a refusal as
 * `allowed: false` for a route that decides later, as the server's does.
 * `reauth` is the route's `reauth: true`: asked only of a caller the grant
 * admits, so one without it never learns whether a proof would have helped.
 */
export function requirePermission(
  resource: DashboardPage,
  action: PermissionAction,
  {
    throwError = true,
    reauth = false,
  }: { throwError?: boolean; reauth?: boolean } = {}
) {
  const grants = liveGrants();
  const { allowed, scope } = resolveActionScope(
    grants.permissions,
    resource,
    action
  );
  if (!allowed && throwError) throw insufficientPermissions();
  if (reauth && allowed) requireReauthWindow();
  return { ...grants, allowed, scope };
}

/**
 * The server's `requireAnyPermission`, answered as a response: the request is
 * refused unless the caller holds one of `actions` on `page`.
 */
export function requireAnyAction(
  page: DashboardPage,
  actions: readonly PermissionAction[]
) {
  const { permissions } = liveGrants();
  if (
    !actions.some(
      (action) => resolveActionScope(permissions, page, action).allowed
    )
  )
    throw insufficientPermissions();
}

/**
 * The server's `validateRolePermissionScope` over `matrix`: a role granting
 * more than the actor holds answers 403 to a `'grant'` and 404 to a
 * `'reachability'`, so a caller cannot tell "outranks me" from "does not exist".
 */
export function assertRoleWithinScope(
  actorPermissions: ActorPermissions,
  matrix: Parameters<typeof toPermissionRows>[0],
  check: 'reachability' | 'grant'
): void {
  if (matrix.length === 0) return;
  try {
    assertRowsWithinScope(actorPermissions, toPermissionRows(matrix));
  } catch (error) {
    if (check === 'grant' || !(error instanceof CustomError)) throw error;
    throw notFoundError();
  }
}

/** The server's `validateAssignableRole`: an active standard role, or 404. */
export function assignableRole(roleId: EntityID) {
  const role = roles.find(roleId);
  if (!role || role.scope !== ROLE_SCOPE.STANDARD || !role.isActive)
    throw notFoundError();
  return role;
}
