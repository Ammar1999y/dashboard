import type { Executor } from '@/db';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';

import { and, eq, inArray, ne } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { roles, sessions, users } from '@/db/schema';

import { listUserSessions, revokeUserSessions } from '@app/shared/api/users';
import {
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
} from '@app/shared/messages/common';

import { auditLog, getAuditMeta } from '@/lib/audit';
import {
  revokeSessionsWhere,
  revokeTrustedDevices,
} from '@/lib/auth/session/rotation';
import { lockTargetAndActor } from '@/lib/auth/user-eligibility';
import { bind } from '@/lib/http/binding';
import { notFoundError } from '@/lib/http/response';
import { liveUser } from '@/lib/users/filters';
import {
  parseCursor,
  parseLimit,
  readSessionsPage,
} from '@/lib/users/session-page';
import {
  assertTargetUserReachable,
  assertTargetUserVisibleUnlocked,
} from '@/lib/users/target-user';

/**
 * The sessions sub-resource admits the owner, or an actor with `users.edit`
 * whose scope and role authority cover the target. The gate has refused
 * anyone else; the parts that need a lock are `assertTargetReachable`'s.
 */
const SESSION_ACCESS = {
  resource: 'users',
  action: 'edit',
  orSelf: 'id',
} as const;

/**
 * `assertTargetUserReachable` over a fresh read of the target; `lock` holds
 * the row `FOR SHARE` for the caller's transaction.
 */
async function assertTargetReachable(
  executor: Executor,
  opts: {
    targetId: EntityID;
    currentUserId: EntityID;
    editScope: 'all' | 'own' | null;
    actorPermissions: ActorPermissions;
    lock: boolean;
  }
): Promise<void> {
  // The role is joined so the parent's visibility predicate runs here too.
  // `is_active` is deliberately NOT required: the parent GET returns a
  // deactivated user, and page two must not 404 where page one succeeded.
  const query = executor
    .select({
      id: users.id,
      roleId: users.roleId,
      createdBy: users.createdBy,
      roleName: roles.roleName,
      roleScope: roles.scope,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(liveUser(eq(users.id, opts.targetId)));

  const [targetUser] = await (opts.lock
    ? query.for('share', { of: users })
    : query);

  if (!targetUser) throw notFoundError();

  await assertTargetUserReachable(executor, {
    isSelf: false,
    roleId: targetUser.roleId,
    createdBy: targetUser.createdBy,
    role: { roleName: targetUser.roleName, scope: targetUser.roleScope },
    actorUserId: opts.currentUserId,
    scope: opts.editScope,
    actorPermissions: opts.actorPermissions,
  });
}

export const listUserSessionsBinding = bind(listUserSessions, {
  permission: SESSION_ACCESS,
  rateLimit: {
    scope: 'users.id.sessions.get',
    limit: 60,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_FETCH_ERROR,
  detail: { summary: 'List a user’s active sessions', tags: ['Sessions'] },
  handler: async ({ params, query, actor }) => {
    const targetId = params.id;

    if (actor.userId !== targetId)
      await assertTargetReachable(db, {
        targetId,
        currentUserId: actor.userId,
        editScope: actor.scope,
        actorPermissions: actor.permissions,
        lock: false,
      });

    const page = await readSessionsPage({
      userId: targetId,
      currentSessionId: actor.sessionId,
      limit: parseLimit(query.limit ?? null),
      cursor: parseCursor(query.cursor ?? null),
    });

    return {
      message: MSG_FETCHED,
      data: { sessions: page.sessions, nextCursor: page.nextCursor },
    };
  },
});

export const revokeUserSessionsBinding = bind(revokeUserSessions, {
  permission: SESSION_ACCESS,
  rateLimit: {
    scope: 'users.id.sessions.delete',
    limit: 15,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_DELETE_ERROR,
  detail: { summary: 'Revoke a user’s sessions', tags: ['Sessions'] },
  handler: async ({ params, body: request, actor, meta }) => {
    const {
      session,
      userId: currentUserId,
      sessionId: currentSessionId,
      permissions: actorPermissions,
      scope: editScope,
    } = actor;
    const targetId = params.id;
    const isSelf = currentUserId === targetId;

    const revokeAll = 'revokeAll' in request;
    const idsToDelete = revokeAll
      ? []
      : request.sessionIds.filter((id) => id !== currentSessionId);

    const auditMeta = getAuditMeta(meta);

    const revoked = await withTransaction(async (tx) => {
      if (!isSelf)
        await assertTargetUserVisibleUnlocked(tx, {
          targetId,
          actorUserId: currentUserId,
          scope: editScope,
        });
      // The self case too: a password change in another tab holds the row and
      // then waits for the sessions this deletes.
      await lockTargetAndActor(tx, targetId, currentUserId, 'share');
      if (!isSelf)
        await assertTargetReachable(tx, {
          targetId,
          currentUserId,
          editScope,
          actorPermissions,
          lock: true,
        });

      // AFTER `assertTargetReachable`: a request naming only the acting session
      // must still 404 for a target that does not exist.
      if (!revokeAll && idsToDelete.length === 0) return [];

      const deleted = await revokeSessionsWhere(
        tx,
        and(
          eq(sessions.userId, targetId),
          // The acting session is always preserved: "revoke all except
          // current" must not log the operator out mid-remediation.
          currentSessionId ? ne(sessions.id, currentSessionId) : undefined,
          revokeAll ? undefined : inArray(sessions.id, idsToDelete)
        )
      );

      // "Sign out everywhere" has to mean it: a trusted device skips the second
      // factor, is keyed by its own cookie and outlives every session, so
      // leaving it lets an attacker back in with the password alone. Only on
      // `revokeAll` — ending named sessions is housekeeping, not containment.
      if (revokeAll) await revokeTrustedDevices(tx, targetId);

      if (deleted.length > 0) {
        await auditLog(tx, {
          userId: currentUserId,
          userEmail: session.user.email,
          action: 'DELETE',
          tableName: 'sessions',
          recordId: targetId,
          oldData: {
            sessionIds: deleted,
            count: deleted.length,
            ...(revokeAll && { revokedAll: true }),
          },
          newData: {},
          meta: auditMeta,
        });
      }

      return deleted;
    });

    // The set actually revoked, so a request naming only the `isCurrent: true`
    // row — declined by design — is distinguishable from a revocation.
    return { message: MSG_DELETED, data: { revoked } };
  },
});
