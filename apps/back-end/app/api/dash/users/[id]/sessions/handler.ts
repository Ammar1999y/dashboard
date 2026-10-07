import type { Executor } from '@/db';
import type { HandlerInput } from '@/lib/http/contract';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';

import { and, eq, inArray, ne } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { roles, sessions, users } from '@/db/schema';

import {
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
} from '@app/shared/messages/common';
import { deleteSessionsSchema } from '@app/shared/validation/sessions';

import { auditLog, getAuditMeta } from '@/lib/audit';
import {
  revokeSessionsWhere,
  revokeTrustedDevices,
} from '@/lib/auth/session/rotation';
import { lockTargetAndActor } from '@/lib/auth/user-eligibility';
import { readJsonBody, requireId } from '@/lib/http/input';
import { apiSuccess, notFoundError, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { insufficientPermissions } from '@/lib/permissions/checker';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
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
 * whose scope and role authority cover the target. The parts that need a lock
 * are `assertTargetReachable`'s.
 */
async function authorizeSessionAccess(
  ctx: HandlerInput,
  rateLimit: { scope: string; limit: number }
) {
  const {
    session,
    userId: currentUserId,
    sessionId: currentSessionId,
    roleId: actorRoleId,
    scope: editScope,
    permissions: actorPermissions,
  } = await requirePermission(ctx, {
    resource: 'users',
    action: 'edit',
    throwError: false,
  });

  await enforceRateLimit({
    scope: rateLimit.scope,
    identifier: userIdentifier(currentUserId),
    limit: rateLimit.limit,
    failClosed: true,
  });

  const targetId = requireId(ctx.params.id);

  const isSelf = currentUserId === targetId;

  if (!isSelf && !editScope) throw insufficientPermissions();

  // `edit` forces the database read, so this is the live role id rather than
  // the cookie-cached `session.user.roleId`.
  if (isSelf && !actorRoleId) throw insufficientPermissions();

  return {
    session,
    currentUserId,
    currentSessionId,
    targetId,
    isSelf,
    editScope,
    actorPermissions,
  };
}

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

export const GET = withApiErrors(
  'GET /api/dash/users/:id/sessions',
  MSG_FETCH_ERROR,
  async (ctx) => {
    const {
      currentSessionId,
      targetId,
      isSelf,
      currentUserId,
      editScope,
      actorPermissions,
    } = await authorizeSessionAccess(ctx, {
      scope: 'users.id.sessions.get',
      limit: 60,
    });

    if (!isSelf)
      await assertTargetReachable(db, {
        targetId,
        currentUserId,
        editScope,
        actorPermissions,
        lock: false,
      });

    const limit = parseLimit(ctx.query.get('limit'));
    const cursor = parseCursor(ctx.query.get('cursor'));

    const page = await readSessionsPage({
      userId: targetId,
      currentSessionId,
      limit,
      cursor,
    });

    return apiSuccess({
      message: MSG_FETCHED,
      data: { sessions: page.sessions, nextCursor: page.nextCursor },
    });
  }
);

export const DELETE = withApiErrors(
  'DELETE /api/dash/users/:id/sessions',
  MSG_DELETE_ERROR,
  async (ctx) => {
    const {
      session,
      currentUserId,
      currentSessionId,
      targetId,
      isSelf,
      editScope,
      actorPermissions,
    } = await authorizeSessionAccess(ctx, {
      scope: 'users.id.sessions.delete',
      limit: 15,
    });

    const request = await readJsonBody(ctx, deleteSessionsSchema);
    const revokeAll = 'revokeAll' in request;
    const idsToDelete = revokeAll
      ? []
      : request.sessionIds.filter((id) => id !== currentSessionId);

    const auditMeta = getAuditMeta(ctx);

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
    return apiSuccess({ message: MSG_DELETED, data: { revoked } });
  }
);
