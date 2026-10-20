import type { AccessScope } from '@app/shared/permissions/constants';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';

import {
  listUserSessions,
  resetUserTwoFactor,
  revokeUserSessions as revokeSessionsEntry,
} from '@app/shared/api/users';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { MSG_DELETED, MSG_FETCHED } from '@app/shared/messages/common';
import { validID } from '@app/shared/utils';

import { mock } from '../lib/endpoint';
import { notFoundError, requireId } from '../lib/http';
import {
  assertRoleWithinScope,
  insufficientPermissions,
  requirePermission,
} from '../lib/permissions';
import {
  clearTwoFactor,
  endAllSessions,
  rotateCredentials,
  twoFactorOf,
  writeTwoFactor,
} from '../lib/two-factor';
import {
  parseSessionsCursor,
  parseSessionsLimit,
  readSessionsPage,
  revokeUserSessions,
} from '../lib/user-sessions';
import { users } from '../store';
import { assertVisible, targetRoleMatrix } from './users';

interface SessionAccess {
  actorUserId: EntityID;
  targetId: EntityID;
  scope: AccessScope | null;
  permissions: ActorPermissions;
}

/**
 * The server's `authorizeSessionAccess`: the owner, or an actor holding
 * `users.edit`. Whether the target is within reach is `assertTargetReachable`.
 */
function authorizeSessionAccess(targetParam: string): SessionAccess {
  const { userId, scope, permissions } = requirePermission('users', 'edit', {
    throwError: false,
  });
  const targetId = requireId(targetParam);
  if (userId !== targetId && !scope) throw insufficientPermissions();
  return { actorUserId: userId, targetId, scope, permissions };
}

/**
 * Another user's account that is missing, hidden from the actor or out of
 * their role authority is a 404; the owner needs no check.
 */
function assertTargetReachable({
  actorUserId,
  targetId,
  scope,
  permissions,
}: SessionAccess) {
  if (actorUserId === targetId) return;
  const target = users.find(targetId);
  if (!target) throw notFoundError();
  assertVisible(target, actorUserId, scope);
  assertRoleWithinScope(permissions, targetRoleMatrix(target), 'reachability');
}

export const sessionsHandlers = [
  mock(listUserSessions, ({ params, query }) => {
    const access = authorizeSessionAccess(params.id);
    assertTargetReachable(access);
    const limit = parseSessionsLimit(query.get('limit'));
    const cursor = parseSessionsCursor(query.get('cursor'));
    const { sessions, nextCursor } = readSessionsPage({
      userId: access.targetId,
      limit,
      cursor,
    });
    return { message: MSG_FETCHED, data: { sessions, nextCursor } };
  }),

  mock(revokeSessionsEntry, async ({ params, body: read }) => {
    const access = authorizeSessionAccess(params.id);
    const body = await read();
    assertTargetReachable(access);

    const { targetId } = access;
    const revokeAll = 'revokeAll' in body;
    const revoked = revokeUserSessions(
      targetId,
      revokeAll ? 'all' : body.sessionIds
    );
    // Only on `revokeAll`: ending named sessions is housekeeping, not
    // containment, so it leaves the trusted devices.
    if (revokeAll && twoFactorOf(targetId).trustedDevices.length > 0)
      writeTwoFactor(targetId, { trustedDevices: [] });
    return { message: MSG_DELETED, data: { revoked } };
  }),

  mock(resetUserTwoFactor, ({ params }) => {
    const { userId, scope, permissions } = requirePermission(
      'users',
      'resetTwoFactor',
      { reauth: true }
    );
    // A malformed id is a 404 here, unlike the neighbouring routes' 422.
    const targetId = validID(params.id);
    if (!targetId) throw notFoundError();
    assertTargetReachable({
      actorUserId: userId,
      targetId,
      scope,
      permissions,
    });
    if (!users.find(targetId)) throw notFoundError();

    clearTwoFactor(targetId, { deletePasskeys: true });
    rotateCredentials(targetId, 'revoke');
    revokeUserSessions(targetId, 'all');
    endAllSessions(targetId);
    return { message: twoFactorMsg.disabled, data: null };
  }),
];
