import type { PermissionRows } from '@app/shared/permissions/matrix';

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { rolePermissions, roles, sessions, users } from '@/db/schema';

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
  assertRowsWithinScope,
  holdsActionOn,
  validatePermissionScope,
} from '@app/shared/permissions/scope';
import { adminUpdatePermissionBodySchema } from '@app/shared/validation/permissions';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { revokeSessionsWhere } from '@/lib/auth/session/rotation';
import { lockActor } from '@/lib/auth/user-eligibility';
import { handlePermissionUniqueViolation } from '@/lib/http/constraint-errors';
import { readJsonBody, requireId } from '@/lib/http/input';
import { apiSuccess, notFoundError, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
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
import {
  collapseToNotFound,
  validateRolePermissionScope,
} from '@/lib/permissions/scope';
import { refreshRoleSessions } from '@/lib/permissions/session-refresh';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import { liveUser } from '@/lib/users/filters';

export const GET = withApiErrors(MSG_FETCH_ERROR, async (ctx) => {
  const { userId, scope } = await requirePermission(ctx, {
    resource: 'permissions',
    action: 'view',
  });

  await enforceRateLimit({
    scope: 'permissions.id.get',
    identifier: userIdentifier(userId),
    limit: 60,
  });

  const roleId = requireId(ctx.params.id);

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

  return apiSuccess({
    message: MSG_FETCHED,
    data: {
      id: roleData.id,
      roleName: roleData.roleName,
      description: roleData.description,
      isActive: roleData.isActive,
      permissions: toPagePermissions(roleData.rolePermissions),
    },
  });
});

export const PUT = withApiErrors(
  MSG_UPDATE_ERROR,
  async (ctx) => {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
      roleId: actorRoleId,
      scope: editScope,
    } = await requirePermission(ctx, {
      resource: 'permissions',
      action: 'edit',
      reauth: true,
    });

    await enforceRateLimit({
      scope: 'permissions.id.put',
      identifier: userIdentifier(actorUserId),
      limit: 20,
      failClosed: true,
    });

    const roleId = requireId(ctx.params.id);

    // The BODY schema, not the with-`id` variant merged with the path: `id` is
    // not in the published contract, so the strict schema must reject it.
    const input = await readJsonBody(ctx, adminUpdatePermissionBodySchema);

    if (actorRoleId === roleId)
      throw new CustomError(
        permissionMsg.cannotEditOwnRole,
        HTTP_STATUS.FORBIDDEN
      );

    assertStandardRoleName(input.roleName);

    if (input.permissions?.length)
      validatePermissionScope(actorPermissions, input.permissions);

    const auditMeta = getAuditMeta(ctx);

    const updated = await withTransaction(async (tx) => {
      await lockActor(tx, actorUserId);
      const existingRole = await lockOwnedStandardRole(
        tx,
        roleId,
        editScope,
        actorUserId
      );

      // Reachability, because this is the role being EDITED: a 403 would tell
      // an actor without `permissions.view` which roles outrank them.
      await validateRolePermissionScope(
        actorPermissions,
        roleId,
        tx,
        'reachability'
      );

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

        const existingPermissions = await tx
          .select({
            pageName: rolePermissions.pageName,
            permissions: rolePermissions.permissions,
          })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, roleId));

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

      return { updatedAt: roleUpdated.updatedAt };
    });

    // The client refreshes its cache from `updatedAt`.
    return apiSuccess({ message: MSG_UPDATED, data: updated });
  },
  handlePermissionUniqueViolation
);

export const DELETE = withApiErrors(MSG_DELETE_ERROR, async (ctx) => {
  const {
    session,
    userId: actorUserId,
    permissions: actorPermissions,
    scope: deleteScope,
  } = await requirePermission(ctx, {
    resource: 'permissions',
    action: 'delete',
    reauth: true,
  });

  await enforceRateLimit({
    scope: 'permissions.id.delete',
    identifier: userIdentifier(actorUserId),
    limit: 10,
    failClosed: true,
  });

  const roleId = requireId(ctx.params.id);

  const auditMeta = getAuditMeta(ctx);

  await withTransaction(async (tx) => {
    await lockActor(tx, actorUserId);
    const permissionRows = (lock: boolean) => {
      const query = tx
        .select({
          pageName: rolePermissions.pageName,
          permissions: rolePermissions.permissions,
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, roleId));
      return lock ? query.for('share') : query;
    };
    // The reachability question PUT asks through `validateRolePermissionScope`:
    // a deletion grants nothing, so "this role outranks me" answers 404 like
    // every unreachable-target gate.
    const assertReachable = (rows: PermissionRows) => {
      try {
        assertRowsWithinScope(actorPermissions, rows);
      } catch (error) {
        collapseToNotFound(error);
      }
    };

    // Unlocked, before the member locks, so a caller the role is out of reach
    // of gets its 404 without holding anyone's row. Repeated under the locks.
    await assertOwnedStandardRole(tx, roleId, deleteScope, actorUserId);
    assertReachable(await permissionRows(false));

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

    const existingPermissions = await permissionRows(true);
    assertReachable(existingPermissions);

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

    if (deleted.length === 0)
      throw new CustomError(permissionMsg.hasUsers, HTTP_STATUS.BAD_REQUEST);

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

  return apiSuccess({ message: MSG_DELETED });
});
