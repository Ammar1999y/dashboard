import type { Executor } from '@/db';
import type { HandlerInput } from '@/lib/http/contract';
import type { PermissionObject } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';

import { and, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { roles, sessions, users } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_NOT_FOUND,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { deleteSessionsSchema } from '@app/shared/validation/sessions';

import { auditLog, getAuditMeta } from '@/lib/audit';
import {
  revokeSessionArtifacts,
  revokeTrustedDevices,
} from '@/lib/auth/session/rotation';
import { readJsonBody, requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { insufficientPermissions } from '@/lib/permissions/checker';
import { validateRolePermissionScope } from '@/lib/permissions/utils';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import { assertTargetUserVisible } from '@/lib/users/target-user';

import { formatCursor, parseCursor, parseLimit } from './pagination';

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

/** Ownership + role-authority check on the target, under a shared lock. */
async function assertTargetReachable(
  executor: Executor,
  opts: {
    targetId: EntityID;
    currentUserId: EntityID;
    editScope: 'all' | 'own' | null;
    actorPermissions: Partial<PermissionObject> | undefined;
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
    .where(and(eq(users.id, opts.targetId), isNull(users.deletedAt)));

  const [targetUser] = await (opts.lock
    ? query.for('share', { of: users })
    : query);

  if (!targetUser?.roleId)
    throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  assertTargetUserVisible({
    isSelf: false,
    roleId: targetUser.roleId,
    createdBy: targetUser.createdBy,
    role: { roleName: targetUser.roleName, scope: targetUser.roleScope },
    actorUserId: opts.currentUserId,
    scope: opts.editScope,
  });

  if (opts.actorPermissions)
    await validateRolePermissionScope(
      opts.actorPermissions,
      targetUser.roleId,
      executor,
      'reachability'
    );
}

/**
 * Cursor-paginated active sessions, newest first.
 *
 * Keyset on `(createdAt, id)` rather than OFFSET: session rows are deleted
 * concurrently by every revocation path, and OFFSET would skip or repeat rows
 * as the set shifts underneath the pages.
 */
export const GET = withApiErrors(MSG_FETCH_ERROR, async (ctx) => {
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

  const rows = await db
    .select({
      id: sessions.id,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, targetId),
        gt(sessions.expiresAt, sql`now()`),
        cursor
          ? sql`(${sessions.createdAt}, ${sessions.id}) < (${cursor.createdAt}, ${cursor.id}::uuid)`
          : undefined
      )
    )
    .orderBy(desc(sessions.createdAt), desc(sessions.id))
    // One extra row is the cheapest reliable "is there another page" probe.
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return apiSuccess({
    message: MSG_FETCHED,
    data: {
      sessions: page.map((s) => ({
        ...s,
        isCurrent: s.id === currentSessionId,
      })),
      nextCursor:
        hasMore && last ? formatCursor(last.createdAt, last.id) : null,
    },
  });
});

export const DELETE = withApiErrors(MSG_DELETE_ERROR, async (ctx) => {
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

    const deleted = await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, targetId),
          // The acting session is always preserved: "revoke all except
          // current" must not log the operator out mid-remediation.
          currentSessionId ? ne(sessions.id, currentSessionId) : undefined,
          revokeAll ? undefined : inArray(sessions.id, idsToDelete)
        )
      )
      .returning({ id: sessions.id });

    // The revoked sessions' re-authentication windows and two-factor proofs
    // go with them; nothing can reach those rows once the session is gone.
    await revokeSessionArtifacts(
      tx,
      deleted.map((s) => s.id)
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
          sessionIds: deleted.map((s) => s.id),
          count: deleted.length,
          ...(revokeAll && { revokedAll: true }),
        },
        newData: {},
        meta: auditMeta,
      });
    }

    return deleted.map((row) => row.id);
  });

  // The set actually revoked, so a request naming only the `isCurrent: true`
  // row — declined by design — is distinguishable from a revocation.
  return apiSuccess({ message: MSG_DELETED, data: { revoked } });
});
