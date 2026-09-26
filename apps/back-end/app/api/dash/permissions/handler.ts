import type { FilterColumnSpecs } from '@/lib/data-table/column-specs';
import type { PermissionRows } from '@/lib/permissions/utils';

import { and, count, eq, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { rolePermissions, roles } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_CREATE_ERROR,
  MSG_CREATED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { ROLE_SCOPE } from '@app/shared/permissions/constants';
import { createPermissionSchema } from '@app/shared/validation/permissions';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { parseDataTableParams } from '@/lib/data-table/params';
import { handlePermissionUniqueViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { permissionMsg } from '@/lib/permissions/messages';
import {
  assertStandardRoleName,
  diffPermissionMatrices,
  PERMISSION_AUDIT_VERSION,
  validatePermissionScope,
} from '@/lib/permissions/utils';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

// See USERS_FILTER_COLUMNS for why the scan-only operator is permitted here.
export const PERMISSIONS_FILTER_COLUMNS: FilterColumnSpecs = {
  roleName: { type: 'text', allowScanOnly: true },
  description: { type: 'text', allowScanOnly: true },
  isActive: { type: 'boolean' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};

export const GET = withApiErrors(MSG_FETCH_ERROR, async (ctx) => {
  const { userId, scope } = await requirePermission(ctx, {
    resource: 'permissions',
    action: 'view',
  });

  await enforceRateLimit({
    scope: 'permissions.get',
    identifier: userIdentifier(userId),
    limit: 60,
  });

  const { where, orderBy, limit, offset, page, perPage, buildPageCount } =
    parseDataTableParams(roles, {
      url: ctx.url,
      filterableColumns: PERMISSIONS_FILTER_COLUMNS,
      searchableColumns: ['roleName', 'description'],
      defaultSort: { id: 'createdAt', desc: true },
    });

  const baseFilter = and(
    eq(roles.scope, ROLE_SCOPE.STANDARD),
    scope === 'own' ? eq(roles.createdBy, userId) : undefined,
    where
  );

  const [rolesWithCounts, [totalRow]] = await Promise.all([
    db
      .select({
        id: roles.id,
        roleName: roles.roleName,
        description: roles.description,
        isActive: roles.isActive,
        createdAt: roles.createdAt,
        updatedAt: roles.updatedAt,
        usersCount: sql<number>`(
          SELECT COUNT(*) FROM users
          WHERE role_id = ${roles.id} AND deleted_at IS NULL
        )`.mapWith(Number),
      })
      .from(roles)
      .where(baseFilter)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(roles).where(baseFilter),
  ]);

  const total = totalRow?.total ?? 0;

  return apiSuccess({
    message: MSG_FETCHED,
    data: rolesWithCounts,
    meta: {
      page,
      perPage,
      total,
      pageCount: buildPageCount(total),
    },
  });
});

export const POST = withApiErrors(
  MSG_CREATE_ERROR,
  async (ctx) => {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
    } = await requirePermission(ctx, {
      resource: 'permissions',
      action: 'create',
      reauth: true,
    });

    await enforceRateLimit({
      scope: 'permissions.post',
      identifier: userIdentifier(actorUserId),
      limit: 20,
      failClosed: true,
    });

    // Lenient on unknown TOP-LEVEL keys, like the users collection POST, so a
    // client may post back a response object carrying server-owned fields.
    // Nested page/action objects stay strict and every written field is
    // required, so a misspelled key fails as a missing field. PUT is strict.
    const input = await readJsonBody(ctx, createPermissionSchema);

    assertStandardRoleName(input.roleName);

    if (actorPermissions && input.permissions?.length)
      validatePermissionScope(actorPermissions, input.permissions);

    const auditMeta = getAuditMeta(ctx);

    const newId = await withTransaction(async (tx) => {
      const [newRole] = await tx
        .insert(roles)
        .values({
          roleName: input.roleName,
          description: input.description,
          isActive: input.isActive,
          createdBy: actorUserId,
        })
        .returning({ id: roles.id });

      if (!newRole)
        throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

      const newPermissionsForAudit: PermissionRows = [];

      if (input.permissions && input.permissions.length > 0) {
        const permissionsData = input.permissions.map((p) => ({
          roleId: newRole.id,
          pageName: p.name,
          permissions: p.permissions,
        }));
        await tx.insert(rolePermissions).values(permissionsData);
        newPermissionsForAudit.push(
          ...permissionsData.map((p) => ({
            pageName: p.pageName,
            permissions: p.permissions,
          }))
        );
      }

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'INSERT',
        tableName: 'roles',
        recordId: newRole.id,
        newData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          roleName: input.roleName,
          description: input.description,
          isActive: input.isActive,
          // The `{ pageName, permissions }` shape and `changedPermissions`
          // summary every role event uses; the request keys pages as `name`.
          ...(newPermissionsForAudit.length > 0 && {
            permissions: newPermissionsForAudit,
            changedPermissions: diffPermissionMatrices(
              [],
              newPermissionsForAudit
            ),
          }),
        },
        meta: auditMeta,
      });

      return newRole.id;
    });

    return apiSuccess({
      message: MSG_CREATED,
      data: { id: newId },
      status: HTTP_STATUS.CREATED,
    });
  },
  (error) => handlePermissionUniqueViolation(error, permissionMsg)
);
