import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

import { deleteUser, getUser, updateUser } from '@app/shared/api/users';
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
import { SESSIONS_PAGE_SIZE } from '@app/shared/validation/sessions';

import { getAuditMeta } from '@/lib/audit';
import { bind } from '@/lib/http/binding';
import { handleUserConstraintViolation } from '@/lib/http/constraint-errors';
import { notFoundError } from '@/lib/http/response';
import { insufficientPermissions } from '@/lib/permissions/checker';
import { publicRoleFields } from '@/lib/permissions/roles';
import { softDeleteUser } from '@/lib/users/delete';
import { editUserAsAdmin } from '@/lib/users/edit';
import { liveUser } from '@/lib/users/filters';
import { readSessionsPage } from '@/lib/users/session-page';
import {
  actorCoversTargetRole,
  assertTargetUserVisible,
} from '@/lib/users/target-user';

export const getUserBinding = bind(getUser, {
  permission: { resource: 'users', action: 'view', orSelf: 'id' },
  rateLimit: { scope: 'users.id.get', limit: 60, by: 'user' },
  failure: MSG_FETCH_ERROR,
  detail: { summary: 'Get a dashboard user', tags: ['Users'] },
  handler: async ({ params, actor }) => {
    const {
      userId,
      sessionId,
      scope: viewScope,
      permissions: actorViewPermissions,
    } = actor;
    const targetId = params.id;

    const isSelf = userId === targetId;

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

    return {
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
        createdAt: userData.createdAt.toISOString(),
        updatedAt: userData.updatedAt.toISOString(),
        permissions,
        ...(sessionPage && {
          sessions: sessionPage.sessions,
          sessionsHasMore: sessionPage.hasMore,
          sessionsNextCursor: sessionPage.nextCursor,
        }),
      },
    };
  },
});

export const updateUserBinding = bind(updateUser, {
  permission: {
    resource: 'users',
    action: 'edit',
    notSelf: 'id',
    handlerAsksReauth: true,
  },
  rateLimit: {
    scope: 'users.id.put',
    limit: 10,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_UPDATE_ERROR,
  mapError: handleUserConstraintViolation,
  detail: {
    summary: 'Update a dashboard user',
    description:
      'Updates another user’s account; naming your own id is refused 403 (rename yourself through `PUT /api/dash/users/me`). A change to the password, email, phone, role, permissions or active flag requires re-authentication.',
    tags: ['Users'],
  },
  handler: async ({ params, body: input, actor, meta }) => {
    const {
      session,
      sessionId,
      userId,
      scope: editScope,
      permissions: actorPermissions,
    } = actor;
    const targetId = params.id;

    // The gate refused both already (`notSelf`, the grant); kept because
    // `editUserAsAdmin` would let a caller change their own role or active flag.
    if (!editScope || userId === targetId) throw insufficientPermissions();

    const { updatedAt } = await editUserAsAdmin({
      actor: { userId, sessionId, userEmail: session.user.email },
      actorPermissions,
      editScope,
      targetId,
      input,
      auditMeta: getAuditMeta(meta),
    });
    return {
      message: MSG_UPDATED,
      data: { updatedAt: updatedAt.toISOString() },
    };
  },
});

export const deleteUserBinding = bind(deleteUser, {
  permission: { resource: 'users', action: 'delete' },
  rateLimit: {
    scope: 'users.id.delete',
    limit: 10,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_DELETE_ERROR,
  detail: {
    summary: 'Delete a dashboard user',
    description: 'This operation requires re-authentication.',
    tags: ['Users'],
  },
  handler: async ({ params, actor, meta }) => {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
      scope: deleteScope,
    } = actor;
    const targetId = params.id;

    if (actorUserId === targetId)
      throw new CustomError(userMsg.cannotDeleteSelf, HTTP_STATUS.BAD_REQUEST);

    await softDeleteUser({
      targetId,
      actor: { userId: actorUserId, email: session.user.email },
      deleteScope,
      actorPermissions,
      auditMeta: getAuditMeta(meta),
    });

    return { message: MSG_DELETED, data: null };
  },
});
