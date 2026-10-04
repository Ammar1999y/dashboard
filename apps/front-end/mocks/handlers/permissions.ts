import type { MockRole } from '../store';
import type { AccessScope } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';

import { http } from 'msw';
import { REQUEST_BODIES } from '@app/shared/contract';
import { PERMISSIONS_FILTER_COLUMNS } from '@app/shared/data-table/filterable-columns';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_DELETED, MSG_UPDATED } from '@app/shared/messages/common';
import {
  MSG_CANNOT_EDIT_OWN_ROLE,
  MSG_ROLE_HAS_USERS,
  MSG_ROLE_NAME_EXISTS,
} from '@app/shared/messages/permissions';
import { ROLE_SCOPE } from '@app/shared/permissions/constants';
import { assertStandardRoleName } from '@app/shared/permissions/roles';
import {
  holdsActionOn,
  validatePermissionScope,
} from '@app/shared/permissions/scope';

import { generateEntityId } from '@/utils/generate-id';

import { queryTable } from '../lib/data-table';
import { now } from '../lib/db';
import {
  api,
  created,
  notFoundError,
  ok,
  okPage,
  readJsonBody,
  requireId,
} from '../lib/http';
import {
  assertRoleWithinScope,
  insufficientPermissions,
  requirePermission,
} from '../lib/permissions';
import { roleRef, roles, users } from '../store';

/**
 * Only standard roles are managed here; system and custom ones are not. An
 * `'own'` scope reaches the roles the caller created.
 */
const reachableRoles = (scope: AccessScope | null, actorUserId: EntityID) =>
  roles
    .all()
    .filter(
      (r) =>
        r.scope === ROLE_SCOPE.STANDARD &&
        (scope !== 'own' || r.createdBy === actorUserId)
    );

/** The server's `assertOwnedStandardRole`: the role, or 404 when `scope` does not reach it. */
function ownedStandardRole(
  roleId: EntityID,
  scope: AccessScope | null,
  actorUserId: EntityID
): MockRole {
  const role = roles.find(roleId);
  if (role?.scope !== ROLE_SCOPE.STANDARD) throw notFoundError();
  if (scope === 'own' && role.createdBy !== actorUserId) throw notFoundError();
  return role;
}

const usersCount = (roleId: string) =>
  users.all().filter((u) => u.roleId === roleId).length;

/** `ux_roles_role_name`: exact, over every role. */
function assertNameFree(roleName: string, exceptId?: EntityID) {
  if (roles.all().some((r) => r.id !== exceptId && r.roleName === roleName))
    throw new CustomError(MSG_ROLE_NAME_EXISTS, HTTP_STATUS.CONFLICT);
}

/** Renames reach every user row that embeds this role. */
function syncUsers(role: MockRole) {
  for (const user of users.all()) {
    if (user.roleId === role.id) users.update(user.id, { role: roleRef(role) });
  }
}

export const permissionsHandlers = [
  http.get(api('/api/dash/roles'), () => {
    const { userId, scope } = requirePermission('permissions', 'view');
    return ok(
      reachableRoles(scope, userId)
        .filter((r) => r.isActive)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
        )
        .map(({ id, roleName }) => ({ id, roleName }))
    );
  }),

  http.get(api('/api/dash/permissions'), ({ request }) => {
    const { userId, scope } = requirePermission('permissions', 'view');
    return okPage(
      queryTable(
        reachableRoles(scope, userId).map(
          ({ id, roleName, description, isActive, createdAt, updatedAt }) => ({
            id,
            roleName,
            description,
            isActive,
            createdAt,
            updatedAt,
            usersCount: usersCount(id),
          })
        ),
        new URL(request.url),
        {
          filterableColumns: PERMISSIONS_FILTER_COLUMNS,
          searchableColumns: ['roleName', 'description'],
          defaultSort: { id: 'createdAt', desc: true },
        }
      )
    );
  }),

  http.get<{ id: string }>(api('/api/dash/permissions/:id'), ({ params }) => {
    const { userId, scope } = requirePermission('permissions', 'view');
    const role = ownedStandardRole(requireId(params.id), scope, userId);
    const { id, roleName, description, isActive, permissions } = role;
    return ok({ id, roleName, description, isActive, permissions });
  }),

  http.post(api('/api/dash/permissions'), async ({ request }) => {
    const { userId, permissions } = requirePermission('permissions', 'create');
    const input = await readJsonBody(
      request,
      REQUEST_BODIES['POST /api/dash/permissions']
    );
    assertStandardRoleName(input.roleName);
    if (input.permissions.length > 0)
      validatePermissionScope(permissions, input.permissions);
    assertNameFree(input.roleName);

    const createdAt = now();
    const role = roles.insert({
      id: generateEntityId(),
      roleName: input.roleName,
      description: input.description ?? null,
      isActive: input.isActive,
      scope: ROLE_SCOPE.STANDARD,
      permissions: input.permissions,
      createdBy: userId,
      createdAt,
      updatedAt: createdAt,
    });

    return created(role.id);
  }),

  http.put<{ id: string }>(
    api('/api/dash/permissions/:id'),
    async ({ params, request }) => {
      const {
        userId,
        roleId: actorRoleId,
        scope: editScope,
        permissions,
      } = requirePermission('permissions', 'edit');
      const roleId = requireId(params.id);
      const input = await readJsonBody(
        request,
        REQUEST_BODIES['PUT /api/dash/permissions/:id']
      );

      if (actorRoleId === roleId)
        throw new CustomError(MSG_CANNOT_EDIT_OWN_ROLE, HTTP_STATUS.FORBIDDEN);
      assertStandardRoleName(input.roleName);
      if (input.permissions?.length)
        validatePermissionScope(permissions, input.permissions);

      const existing = ownedStandardRole(roleId, editScope, userId);
      // Reachability: a 403 would tell the caller which roles outrank them.
      assertRoleWithinScope(permissions, existing.permissions, 'reachability');
      const canDeactivate = holdsActionOn(
        permissions,
        'permissions',
        'delete',
        existing.createdBy,
        userId
      );
      if (!canDeactivate && existing.isActive && !input.isActive)
        throw insufficientPermissions();
      assertNameFree(input.roleName, roleId);

      const updatedAt = now();
      const updated = roles.update(roleId, {
        roleName: input.roleName,
        // Omitted keeps the description; only `null` clears it.
        ...(input.description !== undefined && {
          description: input.description,
        }),
        isActive: input.isActive,
        ...(!!input.permissions?.length && { permissions: input.permissions }),
        updatedAt,
      });
      if (updated) syncUsers(updated);

      return ok({ updatedAt }, MSG_UPDATED);
    }
  ),

  http.delete<{ id: string }>(
    api('/api/dash/permissions/:id'),
    ({ params }) => {
      const { userId, scope, permissions } = requirePermission(
        'permissions',
        'delete'
      );
      const role = ownedStandardRole(requireId(params.id), scope, userId);
      assertRoleWithinScope(permissions, role.permissions, 'reachability');
      if (usersCount(role.id) > 0)
        throw new CustomError(MSG_ROLE_HAS_USERS, HTTP_STATUS.BAD_REQUEST);
      roles.remove(role.id);
      return ok(null, MSG_DELETED);
    }
  ),
];
