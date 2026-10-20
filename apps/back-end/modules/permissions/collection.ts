import type { PermissionRows } from '@app/shared/permissions/matrix';

import { and, count, eq } from 'drizzle-orm';

import { dataTableDb, withTransaction } from '@/db';
import { rolePermissions, roles, users } from '@/db/schema';

import { createPermission, listPermissions } from '@app/shared/api/permissions';
import { PERMISSIONS_FILTER_COLUMNS } from '@app/shared/data-table/filterable-columns';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_CREATE_ERROR,
  MSG_CREATED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
} from '@app/shared/messages/common';
import { MSG_INVALID_FILTER } from '@app/shared/messages/data-table';
import {
  diffPermissionMatrices,
  toPermissionRows,
} from '@app/shared/permissions/matrix';
import { assertStandardRoleName } from '@app/shared/permissions/roles';
import { validatePermissionScope } from '@app/shared/permissions/scope';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { parseDataTableParams } from '@/lib/data-table/params';
import { dataTableParameters } from '@/lib/data-table/query-parameters';
import { bind } from '@/lib/http/binding';
import { handlePermissionUniqueViolation } from '@/lib/http/constraint-errors';
import { PERMISSION_AUDIT_VERSION } from '@/lib/permissions/audit';
import { standardScopeFilter } from '@/lib/permissions/roles';
import { liveUser } from '@/lib/users/filters';

export const listPermissionsBinding = bind(listPermissions, {
  permission: { resource: 'permissions', action: 'view' },
  rateLimit: { scope: 'permissions.get', limit: 60, by: 'user' },
  failure: MSG_FETCH_ERROR,
  // Every list-query refusal reads the same, as `parseDataTableParams` answers.
  refusals: {
    query: { status: HTTP_STATUS.UNPROCESSABLE, message: MSG_INVALID_FILTER },
  },
  detail: {
    summary: 'List roles and permission counts',
    tags: ['Permissions'],
    parameters: dataTableParameters(PERMISSIONS_FILTER_COLUMNS),
  },
  handler: async ({ actor, meta }) => {
    const { userId, scope } = actor;

    const { where, orderBy, limit, offset, paginationMeta } =
      parseDataTableParams(roles, {
        url: meta.url,
        filterableColumns: PERMISSIONS_FILTER_COLUMNS,
        searchableColumns: ['roleName', 'description'],
        defaultSort: { id: 'createdAt', desc: true },
      });

    const baseFilter = and(
      standardScopeFilter(),
      scope === 'own' ? eq(roles.createdBy, userId) : undefined,
      where
    );

    const [rolesWithCounts, [totalRow]] = await Promise.all([
      dataTableDb
        .select({
          id: roles.id,
          roleName: roles.roleName,
          description: roles.description,
          isActive: roles.isActive,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt,
          usersCount: dataTableDb.$count(
            users,
            liveUser(eq(users.roleId, roles.id))
          ),
        })
        .from(roles)
        .where(baseFilter)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      dataTableDb.select({ total: count() }).from(roles).where(baseFilter),
    ]);

    return {
      message: MSG_FETCHED,
      data: rolesWithCounts.map((role) => ({
        ...role,
        createdAt: role.createdAt.toISOString(),
        updatedAt: role.updatedAt.toISOString(),
      })),
      meta: paginationMeta(totalRow?.total ?? 0),
    };
  },
});

export const createPermissionBinding = bind(createPermission, {
  permission: { resource: 'permissions', action: 'create' },
  rateLimit: {
    scope: 'permissions.post',
    limit: 20,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_CREATE_ERROR,
  mapError: handlePermissionUniqueViolation,
  detail: {
    summary: 'Create a role and permission matrix',
    description: 'This operation requires re-authentication.',
    tags: ['Permissions'],
  },
  handler: async ({ body: input, actor, meta }) => {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
    } = actor;

    assertStandardRoleName(input.roleName);

    if (input.permissions.length > 0)
      validatePermissionScope(actorPermissions, input.permissions);

    const auditMeta = getAuditMeta(meta);

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

      if (input.permissions.length > 0) {
        const permissionsData = input.permissions.map((p) => ({
          roleId: newRole.id,
          pageName: p.name,
          permissions: p.permissions,
        }));
        await tx.insert(rolePermissions).values(permissionsData);
        newPermissionsForAudit.push(...toPermissionRows(input.permissions));
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

    return { message: MSG_CREATED, data: { id: newId } };
  },
});
