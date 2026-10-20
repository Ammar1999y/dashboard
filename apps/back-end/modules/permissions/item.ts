import type { Tx } from '@/db';
import type { PermissionRows } from '@app/shared/permissions/matrix';
import type { EntityID } from '@app/shared/types';

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { rolePermissions, roles, sessions, users } from '@/db/schema';

import {
  deletePermission,
  getPermission,
  updatePermission,
} from '@app/shared/api/permissions';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_UPDATE_ERROR,
  MSG_UPDATED,
} from '@app/shared/messages/common';
import { permissionMsg } from '@app/shared/messages/permissions';
import {
  REQUIRE_ROLE_FOR_LOGIN,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';
import {
  diffPermissionMatrices,
  permissionsEqual,
  sanitizePermissions,
  toPagePermissions,
  toPermissionRows,
} from '@app/shared/permissions/matrix';
import { assertStandardRoleName } from '@app/shared/permissions/roles';
import {
  holdsActionOn,
  validatePermissionScope,
} from '@app/shared/permissions/scope';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { revokeSessionsWhere } from '@/lib/auth/session/rotation';
import { lockActor } from '@/lib/auth/user-eligibility';
import { bind } from '@/lib/http/binding';
import { handlePermissionUniqueViolation } from '@/lib/http/constraint-errors';
import { notFoundError } from '@/lib/http/response';
import {
  PERMISSION_AUDIT_METADATA_FIELDS,
  PERMISSION_AUDIT_VERSION,
} from '@/lib/permissions/audit';
import { insufficientPermissions } from '@/lib/permissions/checker';
import {
  assertOwnedStandardRole,
  lockOwnedStandardRole,
  standardRoleFilter,
  writeRoleMatrix,
} from '@/lib/permissions/roles';
import { assertRowsReachable } from '@/lib/permissions/scope';
import { refreshRoleSessions } from '@/lib/permissions/session-refresh';
import { liveUser } from '@/lib/users/filters';

/**
 * Takes no lock: every writer of an existing role's matrix holds that role
 * `FOR UPDATE` first, so under the same lock the rows read here cannot change.
 */
function readRoleMatrix(tx: Tx, roleId: EntityID) {
  return tx
    .select({
      pageName: rolePermissions.pageName,
      permissions: rolePermissions.permissions,
    })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
}

function roleHasUsers(): CustomError {
  return new CustomError(permissionMsg.hasUsers, HTTP_STATUS.BAD_REQUEST);
}

export const getPermissionBinding = bind(getPermission, {
  permission: { resource: 'permissions', action: 'view' },
  rateLimit: { scope: 'permissions.id.get', limit: 60, by: 'user' },
  failure: MSG_FETCH_ERROR,
  detail: { summary: 'Get a role permission matrix', tags: ['Permissions'] },
  handler: async ({ params, actor }) => {
    const { userId, scope } = actor;
    const roleId = params.id;

    const roleData = await db.query.roles.findFirst({
      where: standardRoleFilter(roleId),
      columns: {
        id: true,
        roleName: true,
        description: true,
        isActive: true,
        createdBy: true,
      },
      with: {
        rolePermissions: {
          columns: {
            pageName: true,
            permissions: true,
          },
        },
      },
    });

    if (!roleData) throw notFoundError();

    if (scope === 'own' && roleData.createdBy !== userId) throw notFoundError();

    return {
      message: MSG_FETCHED,
      data: {
        id: roleData.id,
        roleName: roleData.roleName,
        description: roleData.description,
        isActive: roleData.isActive,
        permissions: toPagePermissions(roleData.rolePermissions),
      },
    };
  },
});

export const updatePermissionBinding = bind(updatePermission, {
  permission: { resource: 'permissions', action: 'edit' },
  rateLimit: {
    scope: 'permissions.id.put',
    limit: 20,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_UPDATE_ERROR,
  mapError: handlePermissionUniqueViolation,
  detail: {
    summary: 'Update a role permission matrix',
    description:
      '`permissions`, when present, is the COMPLETE matrix and replaces the stored one: a page absent from the array has its grants REVOKED, and the answer is still 200. Send the whole matrix, not a diff. Omitting the key entirely is the only way to leave the current matrix untouched while changing `roleName`, `description` or `isActive`; an empty array is rejected. A role cannot edit its own matrix (403), and this operation requires re-authentication.',
    tags: ['Permissions'],
  },
  handler: async ({ params, body: input, actor, meta }) => {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
      roleId: actorRoleId,
      scope: editScope,
    } = actor;
    const roleId = params.id;

    if (actorRoleId === roleId)
      throw new CustomError(
        permissionMsg.cannotEditOwnRole,
        HTTP_STATUS.FORBIDDEN
      );

    assertStandardRoleName(input.roleName);

    if (input.permissions?.length)
      validatePermissionScope(actorPermissions, input.permissions);

    const auditMeta = getAuditMeta(meta);

    const updated = await withTransaction(async (tx) => {
      await lockActor(tx, actorUserId);
      const existingRole = await lockOwnedStandardRole(
        tx,
        roleId,
        editScope,
        actorUserId
      );
      const existingPermissions = await readRoleMatrix(tx, roleId);

      // Reachability, because this is the role being EDITED: a 403 would tell
      // an actor without `permissions.view` which roles outrank them.
      assertRowsReachable(actorPermissions, existingPermissions);

      const canDeactivate = holdsActionOn(
        actorPermissions,
        'permissions',
        'delete',
        existingRole.createdBy,
        actorUserId
      );

      if (!canDeactivate && existingRole.isActive && input.isActive === false)
        throw insufficientPermissions();

      const [roleUpdated] = await tx
        .update(roles)
        .set({
          roleName: input.roleName,
          description: input.description,
          isActive: input.isActive,
        })
        .where(standardRoleFilter(roleId))
        .returning({ id: roles.id, updatedAt: roles.updatedAt });

      if (!roleUpdated) throw notFoundError();

      let oldPermissionsForAudit: PermissionRows = [];
      let newPermissionsForAudit: PermissionRows = [];

      let permissionsChanged = false;
      if (input.permissions?.length) {
        const submitted = toPermissionRows(input.permissions);
        permissionsChanged = !permissionsEqual(existingPermissions, submitted);

        if (permissionsChanged) {
          oldPermissionsForAudit = existingPermissions;
          newPermissionsForAudit = submitted;
          await writeRoleMatrix(tx, roleId, input.permissions, { prune: true });
        }
      }

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'UPDATE',
        tableName: 'roles',
        recordId: roleId,
        // The `{ pageName, permissions }` shape and `changedPermissions`
        // summary every role event uses; the request keys pages as `name`.
        oldData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          roleName: existingRole.roleName,
          description: existingRole.description,
          isActive: existingRole.isActive,
          ...(permissionsChanged && {
            permissions: oldPermissionsForAudit,
          }),
        },
        newData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          roleName: input.roleName,
          description: input.description,
          isActive: input.isActive,
          ...(permissionsChanged && {
            permissions: newPermissionsForAudit,
            changedPermissions: diffPermissionMatrices(
              oldPermissionsForAudit,
              newPermissionsForAudit
            ),
          }),
        },
        metadataFields: PERMISSION_AUDIT_METADATA_FIELDS,
        meta: auditMeta,
      });

      if (existingRole.isActive && input.isActive === false) {
        await revokeSessionsWhere(
          tx,
          inArray(
            sessions.userId,
            tx
              .select({ id: users.id })
              .from(users)
              .where(liveUser(eq(users.roleId, roleId)))
          )
        );
      } else if (
        permissionsChanged ||
        input.roleName !== existingRole.roleName
      ) {
        const precomputed = input.permissions?.length
          ? {
              roleName: input.roleName,
              roleScope: ROLE_SCOPE.STANDARD,
              permissions: sanitizePermissions(
                toPermissionRows(input.permissions)
              ),
            }
          : undefined;
        await refreshRoleSessions(roleId, tx, precomputed);
      }

      return { updatedAt: roleUpdated.updatedAt.toISOString() };
    });

    // The client refreshes its cache from `updatedAt`.
    return { message: MSG_UPDATED, data: updated };
  },
});

export const deletePermissionBinding = bind(deletePermission, {
  permission: { resource: 'permissions', action: 'delete' },
  rateLimit: {
    scope: 'permissions.id.delete',
    limit: 10,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_DELETE_ERROR,
  detail: {
    summary: 'Delete a role',
    description: 'This operation requires re-authentication.',
    tags: ['Permissions'],
  },
  handler: async ({ params, actor, meta }) => {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
      scope: deleteScope,
    } = actor;
    const roleId = params.id;

    const auditMeta = getAuditMeta(meta);

    await withTransaction(async (tx) => {
      await lockActor(tx, actorUserId);

      // Unlocked, before the member locks, so a caller the role is out of reach
      // of gets its 404 without holding anyone's row. Repeated under the locks.
      // A deletion grants nothing, so "this role outranks me" answers 404 like
      // every unreachable-target gate.
      await assertOwnedStandardRole(tx, roleId, deleteScope, actorUserId);
      assertRowsReachable(actorPermissions, await readRoleMatrix(tx, roleId));

      // Unlocked too: a live member's lock protects nothing here, and taking it
      // would queue the refusal behind whatever request holds that member. The
      // NOT EXISTS below stays the authority.
      const [liveMember] = await tx
        .select({ id: users.id })
        .from(users)
        .where(liveUser(eq(users.roleId, roleId)))
        .limit(1);
      if (liveMember) throw roleHasUsers();

      // Users before the role, the order every writer of a user's role takes
      // (`lockUser`). Held against a restore committing between the unpin and
      // the NOT EXISTS check below, which would trip the FK or leave the restored
      // user with no role. `NO KEY UPDATE`: an audit row's foreign key takes a
      // key-share lock on its actor, and a full `UPDATE` lock would make any
      // member writing one while holding this role a deadlock.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.roleId, roleId))
        .orderBy(users.id)
        .for('no key update');

      const existingRole = await lockOwnedStandardRole(
        tx,
        roleId,
        deleteScope,
        actorUserId
      );

      const existingPermissions = await readRoleMatrix(tx, roleId);
      assertRowsReachable(actorPermissions, existingPermissions);

      // With REQUIRE_ROLE_FOR_LOGIN the FK is RESTRICT, so soft-deleted users
      // still pinning `role_id` would block the DELETE; they are unpinned first.
      // Without it the FK is `set null`.
      if (REQUIRE_ROLE_FOR_LOGIN)
        await tx
          .update(users)
          .set({ roleId: null })
          .where(and(eq(users.roleId, roleId), isNotNull(users.deletedAt)));

      // The scope condition mirrors `standardRoleFilter()`.
      const deleted = await tx.execute(sql`
      DELETE FROM roles r
      WHERE r.id = ${roleId}
        AND r.scope = ${ROLE_SCOPE.STANDARD}
        AND NOT EXISTS (
          SELECT 1 FROM users u
          WHERE u.role_id = r.id AND u.deleted_at IS NULL
        )
      RETURNING r.id
    `);

      if (deleted.length === 0) throw roleHasUsers();

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'DELETE',
        tableName: 'roles',
        recordId: roleId,
        // Same field set the UPDATE and custom-role events record, so a
        // deleted role can be reconstructed from its own event alone.
        oldData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          scope: ROLE_SCOPE.STANDARD,
          roleName: existingRole.roleName,
          description: existingRole.description,
          isActive: existingRole.isActive,
          createdBy: existingRole.createdBy,
          permissions: existingPermissions,
        },
        metadataFields: PERMISSION_AUDIT_METADATA_FIELDS,
        meta: auditMeta,
      });
    });

    return { message: MSG_DELETED, data: null };
  },
});
