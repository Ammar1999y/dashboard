import type { FilterColumnSpecs } from '@/lib/data-table/column-specs';

import { and, count, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { accounts, roles, users } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_CREATE_ERROR,
  MSG_CREATED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
} from '@app/shared/api-messages';
import { PHONE_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { validID } from '@app/shared/utils';
import { createUserSchema } from '@app/shared/validation/auth';

import { auditLog, getAuditMeta } from '@/lib/audit';
import {
  CREDENTIAL_ISSUER,
  CREDENTIAL_PROVIDER_ID,
} from '@/lib/auth/credential';
import { checkPasswordCompromise } from '@/lib/auth/password/compromise';
import { hashPassword } from '@/lib/auth/password/hash';
import { parseDataTableParams } from '@/lib/data-table/params';
import { handleUserConstraintViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { insufficientPermissions } from '@/lib/permissions/checker';
import {
  auditCustomRolePermissions,
  createCustomRole,
  nonSystemRoleFilter,
  validateAssignableRole,
  validatePermissionScope,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

// Server-owned filter contract: keys are the allowlist, and the type decides
// which operators and value shapes are accepted. `allowScanOnly` enables the
// "does not contain" operator, a guaranteed sequential scan that a
// dashboard-sized table affords; turn it off here first if the table grows.
export const USERS_FILTER_COLUMNS: FilterColumnSpecs = {
  name: { type: 'text', allowScanOnly: true },
  email: { type: 'text', allowScanOnly: true },
  isActive: { type: 'boolean' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};

export const GET = withApiErrors(MSG_FETCH_ERROR, async (ctx) => {
  const { userId, scope } = await requirePermission(ctx, {
    resource: 'users',
    action: 'view',
  });

  await enforceRateLimit({
    scope: 'users.get',
    identifier: userIdentifier(userId),
    limit: 60,
  });

  const { where, orderBy, limit, offset, page, perPage, buildPageCount } =
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
        roleId: users.roleId,
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
      roleId: role?.scope === CUSTOM_ROLE_VALUE ? CUSTOM_ROLE_VALUE : u.roleId,
      role: role ? { id: role.id, roleName: role.roleName } : null,
    })),
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
    } = await requirePermission(ctx, { resource: 'users', action: 'create' });

    await enforceRateLimit({
      scope: 'users.post',
      identifier: userIdentifier(actorUserId),
      limit: 20,
      failClosed: true,
    });

    const input = await readJsonBody(ctx, createUserSchema);
    const isCustomRole = input.roleId === CUSTOM_ROLE_VALUE;

    if (isCustomRole && actorPermissions?.['permissions']?.['create'] !== true)
      throw insufficientPermissions();

    if (actorPermissions && isCustomRole && input.permissions?.length)
      validatePermissionScope(actorPermissions, input.permissions);

    // ADDITIVE, never authoritative: the transaction below re-runs both gates
    // under `FOR SHARE` and decides. This only moves the refusal ahead of the
    // outbound HIBP request and the Argon2 hash, which an actor with no
    // authority over the role could otherwise spend on every call. The same
    // preflight as `assertTargetEditable` in `lib/users/edit.ts`.
    if (!isCustomRole) {
      await validateAssignableRole(validID(input.roleId), db);
      if (actorPermissions)
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
      if (!isCustomRole)
        await validateAssignableRole(validID(input.roleId), tx);
      if (actorPermissions && !isCustomRole)
        await validateRolePermissionScope(
          actorPermissions,
          validID(input.roleId),
          tx,
          'grant'
        );

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

      // `issuer` is written although the column defaults to it: Better Auth's
      // sign-in lookup matches on (issuer, accountId), so it decides whether the
      // user can log in at all.
      await tx.insert(accounts).values({
        accountId: userId,
        issuer: CREDENTIAL_ISSUER,
        providerId: CREDENTIAL_PROVIDER_ID,
        userId: userId,
        password: hashedPassword,
      });

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
          newPermissions: customPermissions.map((p) => ({
            pageName: p.name,
            permissions: p.permissions,
          })),
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
