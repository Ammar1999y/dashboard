import { and, desc, eq, gt, sql } from 'drizzle-orm';

import { db } from '@/db';
import { sessions } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
  MSG_UPDATED,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import {
  adminUpdateUserBodySchema,
  selfUpdateUserBodySchema,
} from '@app/shared/validation/auth';
import { SESSIONS_PAGE_SIZE } from '@app/shared/validation/sessions';

import { getAuditMeta } from '@/lib/audit';
import { handleUserConstraintViolation } from '@/lib/http/constraint-errors';
import { parseOrThrow, requireId, requireJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { insufficientPermissions } from '@/lib/permissions/checker';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import { softDeleteUser } from '@/lib/users/delete';
import { editUserAsAdmin, renameSelf } from '@/lib/users/edit';
import { userMsg } from '@/lib/users/messages';
import {
  actorCoversTargetRole,
  assertTargetUserVisible,
} from '@/lib/users/target-user';

import { formatCursor } from './sessions/pagination';

export const GET = withApiErrors(MSG_FETCH_ERROR, async (ctx) => {
  const {
    userId,
    sessionId,
    roleId: actorRoleId,
    scope: viewScope,
    permissions: actorViewPermissions,
  } = await requirePermission(ctx, {
    resource: 'users',
    action: 'view',
    throwError: false,
  });

  await enforceRateLimit({
    scope: 'users.id.get',
    identifier: userIdentifier(userId),
    limit: 60,
  });

  const targetId = requireId(ctx.params.id);

  const isSelf = userId === targetId;

  if (!isSelf && !viewScope) throw insufficientPermissions();

  // Owner decision: `view` is a read action, so this role id is the cookie-cached
  // copy — the revocation window every read route accepts. Forcing the database
  // here would make the cache pointless.
  if (isSelf && !actorRoleId) throw insufficientPermissions();

  const editAll = actorViewPermissions?.users?.edit === true;
  const editOwn = actorViewPermissions?.users?.editOwn === true;

  const userData = await db.query.users.findFirst({
    where: (users, { eq, and, isNull }) =>
      and(eq(users.id, targetId), isNull(users.deletedAt)),
    columns: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      phoneNumber: true,
      phoneNumberVerified: true,
      isActive: true,
      roleId: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      role: {
        columns: {
          id: true,
          roleName: true,
          scope: true,
        },
        with: {
          rolePermissions: {
            columns: {
              pageName: true,
              permissions: true,
            },
          },
        },
      },
    },
  });

  if (!userData) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  // The predicate the sessions subresource shares, so parent and child cannot
  // drift.
  const targetRoleId = assertTargetUserVisible({
    isSelf,
    roleId: userData.roleId,
    createdBy: userData.createdBy,
    role: userData.role,
    actorUserId: userId,
    scope: viewScope,
  });

  // Session metadata (IP, user-agent) is gated by the role authority the
  // sessions endpoints require, or page one here would bypass their check.
  const showSessions =
    (isSelf || editAll || (editOwn && userData.createdBy === userId)) &&
    (isSelf ||
      (await actorCoversTargetRole(actorViewPermissions, targetRoleId, db)));

  const permissions =
    userData.role?.rolePermissions?.map((p) => ({
      name: p.pageName,
      permissions: p.permissions,
    })) || [];

  // Read only after every visibility gate has passed, which needs the user row
  // first — sequential by necessity. First page only; `sessionsHasMore` and the
  // cursor send the client to GET /dash/users/:id/sessions for the rest.
  const sessionRows = showSessions
    ? await db
        .select({
          id: sessions.id,
          ipAddress: sessions.ipAddress,
          userAgent: sessions.userAgent,
          createdAt: sessions.createdAt,
        })
        .from(sessions)
        .where(
          and(eq(sessions.userId, targetId), gt(sessions.expiresAt, sql`now()`))
        )
        .orderBy(desc(sessions.createdAt), desc(sessions.id))
        .limit(SESSIONS_PAGE_SIZE + 1)
    : null;

  const sessionsHasMore =
    !!sessionRows && sessionRows.length > SESSIONS_PAGE_SIZE;

  const userSessions = sessionRows
    ? sessionRows.slice(0, SESSIONS_PAGE_SIZE).map((s) => ({
        ...s,
        isCurrent: s.id === sessionId,
      }))
    : undefined;

  // Page two's cursor in the child route's exact format; without it the child
  // endpoint re-serves page one.
  const lastSession = userSessions?.at(-1);
  const sessionsNextCursor =
    sessionsHasMore && lastSession
      ? formatCursor(lastSession.createdAt, lastSession.id)
      : null;

  return apiSuccess({
    message: MSG_FETCHED,
    data: {
      id: userData.id,
      name: userData.name,
      email: userData.email,
      emailVerified: userData.emailVerified,
      phoneNumber: userData.phoneNumber,
      phoneNumberVerified: userData.phoneNumberVerified,
      isActive: userData.isActive,
      roleId:
        userData.role?.scope === CUSTOM_ROLE_VALUE
          ? CUSTOM_ROLE_VALUE
          : userData.roleId,
      role: userData.role
        ? {
            id: userData.role.id,
            roleName: userData.role.roleName,
          }
        : null,
      createdAt: userData.createdAt,
      updatedAt: userData.updatedAt,
      permissions,
      ...(userSessions && {
        sessions: userSessions,
        sessionsHasMore,
        sessionsNextCursor,
      }),
    },
  });
});

export const PUT = withApiErrors(
  MSG_UPDATE_ERROR,
  async (ctx) => {
    const {
      session,
      sessionId,
      userId,
      roleId: actorRoleId,
      scope: editScope,
      permissions: actorPermissions,
    } = await requirePermission(ctx, {
      resource: 'users',
      action: 'edit',
      throwError: false,
      // No `reauth`, unlike the other `D12` routes: this route serves two
      // operations behind one permission read, and a window demanded before
      // the branch reaches a user renaming THEMSELVES and inverts 401-before-403
      // for a caller with no grant. `editUserAsAdmin` asks for it on the
      // changes that earn it.
    });

    await enforceRateLimit({
      scope: 'users.id.put',
      identifier: userIdentifier(userId),
      limit: 10,
      failClosed: true,
    });

    // Ahead of the id check, so a malformed body's 400 precedes a bad id's 422.
    const body = requireJsonBody(await ctx.readJson());
    const auditMeta = getAuditMeta(ctx);

    const targetId = requireId(ctx.params.id);

    if (userId === targetId) {
      // `edit` forces the database read, so this is the live role id rather
      // than the cookie-cached `session.user.roleId`.
      if (!actorRoleId) throw insufficientPermissions();
      const input = parseOrThrow(selfUpdateUserBodySchema, body);
      const selfResult = await renameSelf(
        { userId, userEmail: session.user.email },
        input.name,
        auditMeta
      );
      return apiSuccess({ message: MSG_UPDATED, data: selfResult });
    }

    if (!editScope) throw insufficientPermissions();

    // Strict: an unknown key is a 422 rather than stripped, so a misspelled
    // `passwrod` cannot read as "not supplied" and answer 200. The BODY schema,
    // because `id` is not in the published contract.
    const input = parseOrThrow(adminUpdateUserBodySchema, body);
    const adminResult = await editUserAsAdmin({
      actor: { userId, sessionId, userEmail: session.user.email },
      actorPermissions,
      editScope,
      targetId,
      input,
      auditMeta,
    });
    return apiSuccess({ message: MSG_UPDATED, data: adminResult });
  },
  handleUserConstraintViolation
);

export const DELETE = withApiErrors(MSG_DELETE_ERROR, async (ctx) => {
  const {
    session,
    userId: actorUserId,
    permissions: actorPermissions,
    scope: deleteScope,
  } = await requirePermission(ctx, {
    resource: 'users',
    action: 'delete',
    reauth: true,
  });

  await enforceRateLimit({
    scope: 'users.id.delete',
    identifier: userIdentifier(actorUserId),
    limit: 10,
    failClosed: true,
  });

  const targetId = requireId(ctx.params.id);

  if (actorUserId === targetId)
    throw new CustomError(userMsg.cannotDeleteSelf, HTTP_STATUS.BAD_REQUEST);

  await softDeleteUser({
    targetId,
    actor: { userId: actorUserId, email: session.user.email },
    deleteScope,
    actorPermissions,
    auditMeta: getAuditMeta(ctx),
  });

  return apiSuccess({ message: MSG_DELETED });
});
