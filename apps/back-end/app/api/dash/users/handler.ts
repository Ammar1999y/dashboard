import { and, count, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { roles, users } from '@/db/schema';

import { PHONE_ENABLED } from '@app/shared/config';
import { USERS_FILTER_COLUMNS } from '@app/shared/data-table/filterable-columns';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_CREATE_ERROR,
  MSG_CREATED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
} from '@app/shared/messages/common';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { toPermissionRows } from '@app/shared/permissions/matrix';
import {
  resolveActionScope,
  validatePermissionScope,
} from '@app/shared/permissions/scope';
import { validID } from '@app/shared/utils';
import { createUserSchema } from '@app/shared/validation/auth';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { insertCredentialAccount } from '@/lib/auth/credential-account';
import { checkPasswordCompromise } from '@/lib/auth/password/compromise';
import { hashPassword } from '@/lib/auth/password/hash';
import { lockActor } from '@/lib/auth/user-eligibility';
import { parseDataTableParams } from '@/lib/data-table/params';
import { handleUserConstraintViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { auditCustomRolePermissions } from '@/lib/permissions/audit';
import { insufficientPermissions } from '@/lib/permissions/checker';
import {
  createCustomRole,
  nonSystemRoleFilter,
  publicRoleFields,
  validateAssignableRole,
} from '@/lib/permissions/roles';
import { validateRolePermissionScope } from '@/lib/permissions/scope';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

export const GET = withApiErrors(
  'GET /api/dash/users',
  MSG_FETCH_ERROR,
  async (ctx) => {
    const { userId, scope } = await requirePermission(ctx, {
      resource: 'users',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'users.get',
      identifier: userIdentifier(userId),
      limit: 60,
    });

    const { where, orderBy, limit, offset, paginationMeta } =
      parseDataTableParams(users, {
        url: ctx.url,
        filterableColumns: USERS_FILTER_COLUMNS,
        searchableColumns: ['name', 'email'],
        defaultSort: { id: 'createdAt', desc: true },
      });

    const baseFilter = and(
      isNull(users.deletedAt),
      nonSystemRoleFilter(),
      scope === 'own' ? eq(users.createdBy, userId) : undefined,
      where
    );

    const [dashboardUsers, [totalRow]] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          isActive: users.isActive,
          // The inner join's own column, which cannot be null.
          roleId: roles.id,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
          role: {
            id: roles.id,
            roleName: roles.roleName,
            scope: roles.scope,
          },
        })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(baseFilter)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(baseFilter),
    ]);

    const total = totalRow?.total ?? 0;

    return apiSuccess({
      message: MSG_FETCHED,
      data: dashboardUsers.map(({ role, ...u }) => ({
        ...u,
        ...publicRoleFields(u.roleId, role),
      })),
      meta: paginationMeta(total),
    });
  }
);

export const POST = withApiErrors(
  'POST /api/dash/users',
  MSG_CREATE_ERROR,
  async (ctx) => {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
    } = await requirePermission(ctx, {
      resource: 'users',
      action: 'create',
      reauth: true,
    });

    await enforceRateLimit({
      scope: 'users.post',
      identifier: userIdentifier(actorUserId),
      limit: 20,
      failClosed: true,
    });

    const input = await readJsonBody(ctx, createUserSchema);
    const isCustomRole = input.roleId === CUSTOM_ROLE_VALUE;

    if (
      isCustomRole &&
      !resolveActionScope(actorPermissions, 'permissions', 'create').allowed
    )
      throw insufficientPermissions();

    if (isCustomRole && input.permissions?.length)
      validatePermissionScope(actorPermissions, input.permissions);

    // ADDITIVE, never authoritative: the transaction below re-runs both gates
    // under `FOR SHARE` and decides. This only moves the refusal ahead of the
    // outbound HIBP request and the Argon2 hash, which an actor with no
    // authority over the role could otherwise spend on every call. The same
    // preflight as `assertTargetEditable` in `lib/users/edit.ts`.
    if (!isCustomRole) {
      await validateAssignableRole(validID(input.roleId), db);
      await validateRolePermissionScope(
        actorPermissions,
        validID(input.roleId),
        db,
        'grant'
      );
    }

    // HIBP before Argon2, so a rejected password costs no hash.
    await checkPasswordCompromise(input.password);

    const hashedPassword = await hashPassword(input.password);
    const auditMeta = getAuditMeta(ctx);

    const newId = await withTransaction(async (tx) => {
      await lockActor(tx, actorUserId);
      if (!isCustomRole) {
        await validateAssignableRole(validID(input.roleId), tx);
        await validateRolePermissionScope(
          actorPermissions,
          validID(input.roleId),
          tx,
          'grant'
        );
      }

      const customPermissions =
        isCustomRole && input.permissions?.length ? input.permissions : null;

      const assignedRoleId = customPermissions
        ? await createCustomRole(tx, customPermissions, null, actorUserId)
        : input.roleId;

      const [newUser] = await tx
        .insert(users)
        .values({
          name: input.name,
          email: input.email,
          roleId: validID(assignedRoleId),
          isActive: input.isActive,
          createdBy: actorUserId,
          // An admin-set number is unproven, so `phoneNumberVerified` keeps
          // its `false` default.
          ...(PHONE_ENABLED &&
            input.phoneNumber && {
              phoneNumber: input.phoneNumber,
            }),
        })
        .returning({ id: users.id });

      if (!newUser)
        throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

      const userId = newUser.id;

      await insertCredentialAccount(tx, userId, hashedPassword);

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'INSERT',
        tableName: 'users',
        recordId: userId,
        newData: {
          name: input.name,
          email: input.email,
          roleId: assignedRoleId,
          isActive: input.isActive,
          ...(PHONE_ENABLED &&
            input.phoneNumber && {
              phoneNumber: input.phoneNumber,
            }),
        },
        meta: auditMeta,
      });

      // The user event records only the role id; this keeps the matrix a
      // custom role was born with.
      if (customPermissions)
        await auditCustomRolePermissions(tx, {
          actorUserId,
          actorEmail: session.user.email,
          roleId: validID(assignedRoleId),
          newPermissions: toPermissionRows(customPermissions),
          targetUserId: userId,
          meta: auditMeta,
        });

      return userId;
    });

    return apiSuccess({
      message: MSG_CREATED,
      data: { id: newId },
      status: HTTP_STATUS.CREATED,
    });
  },
  handleUserConstraintViolation
);
