import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

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
import { userMsg } from '@app/shared/messages/users';
import { toPagePermissions } from '@app/shared/permissions/matrix';
import { holdsActionOn } from '@app/shared/permissions/scope';
import {
  adminUpdateUserBodySchema,
  selfUpdateUserBodySchema,
} from '@app/shared/validation/auth';
import { SESSIONS_PAGE_SIZE } from '@app/shared/validation/sessions';

import { getAuditMeta } from '@/lib/audit';
import { handleUserConstraintViolation } from '@/lib/http/constraint-errors';
import { parseOrThrow, requireId, requireJsonBody } from '@/lib/http/input';
import { apiSuccess, notFoundError, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { insufficientPermissions } from '@/lib/permissions/checker';
import { publicRoleFields } from '@/lib/permissions/roles';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import { softDeleteUser } from '@/lib/users/delete';
import { editUserAsAdmin, renameSelf } from '@/lib/users/edit';
import { liveUser } from '@/lib/users/filters';
import { readSessionsPage } from '@/lib/users/session-page';
import {
  actorCoversTargetRole,
  assertTargetUserVisible,
} from '@/lib/users/target-user';

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

  const userData = await db.query.users.findFirst({
    where: liveUser(eq(users.id, targetId)),
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

  if (!userData) throw notFoundError();

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
    (isSelf ||
      holdsActionOn(
        actorViewPermissions,
        'users',
        'edit',
        userData.createdBy,
        userId
      )) &&
    (isSelf ||
      (await actorCoversTargetRole(actorViewPermissions, targetRoleId, db)));

  const permissions = userData.role?.rolePermissions
    ? toPagePermissions(userData.role.rolePermissions)
    : [];

  // Read only after every visibility gate has passed, which needs the user row
  // first — sequential by necessity. First page only; `sessionsHasMore` and the
  // cursor send the client to GET /dash/users/:id/sessions for the rest, and
  // without the cursor that route re-serves page one.
  const sessionPage = showSessions
    ? await readSessionsPage({
        userId: targetId,
        currentSessionId: sessionId,
        limit: SESSIONS_PAGE_SIZE,
        cursor: null,
      })
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
      ...publicRoleFields(userData.roleId, userData.role),
      createdAt: userData.createdAt,
      updatedAt: userData.updatedAt,
      permissions,
      ...(sessionPage && {
        sessions: sessionPage.sessions,
        sessionsHasMore: sessionPage.hasMore,
        sessionsNextCursor: sessionPage.nextCursor,
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
