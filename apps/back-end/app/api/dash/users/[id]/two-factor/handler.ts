import { eq } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { roles, users } from '@/db/schema';

import { twoFactorMsg } from '@app/shared/messages/auth';
import { MSG_UPDATE_ERROR } from '@app/shared/messages/common';

import { auditLog, getAuditMeta } from '@/lib/audit';
import {
  revokeOtherSessions,
  revokePendingProofs,
} from '@/lib/auth/session/rotation';
import { clearTwoFactorEnrolment } from '@/lib/auth/two-factor/methods';
import { lockTargetAndActor } from '@/lib/auth/user-eligibility';
import { requireId } from '@/lib/http/input';
import { apiSuccess, notFoundError, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { validateRolePermissionScope } from '@/lib/permissions/scope';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import { liveUser } from '@/lib/users/filters';
import {
  assertTargetUserVisible,
  assertTargetUserVisibleUnlocked,
} from '@/lib/users/target-user';

/**
 * Clears a user's second factor entirely — the only path back for a user who
 * lost every factor, since password recovery refuses to defeat one.
 *
 * `resetTwoFactor` is its own permission rather than part of `edit`: it is the
 * one grant that removes a security control from someone else's account.
 */
export const POST = withApiErrors(
  'POST /api/dash/users/:id/two-factor/reset',
  MSG_UPDATE_ERROR,
  async (ctx) => {
    // ⚠️ Deliberately NOT gated on the configured method list: stored 2FA state
    // outlives the configuration that created it, and under an empty list this
    // reset is the only exit for an account still holding it.
    const {
      session,
      userId: actorUserId,
      scope,
      permissions: actorPermissions,
    } = await requirePermission(ctx, {
      resource: 'users',
      action: 'resetTwoFactor',
      // Not the cookie cache: this revokes a security control, so the grant
      // behind it has to be the current one.
      forceDB: true,
      // The SELF-target case is in scope: `assertTargetUserVisible` exempts
      // self from both its narrowings, so without this a hijacked administrator
      // session disarms its own second factor by POSTing its own id.
      reauth: true,
    });

    await enforceRateLimit({
      scope: 'users.two-factor.reset',
      identifier: userIdentifier(actorUserId),
      limit: 10,
      failClosed: true,
    });

    const targetId = requireId(ctx.params.id, notFoundError);

    const auditMeta = getAuditMeta(ctx);

    await withTransaction(async (tx) => {
      await assertTargetUserVisibleUnlocked(tx, {
        targetId,
        actorUserId,
        scope,
      });
      // Locked first, keeping the canonical order (users -> everything else),
      // and joined so the authorization below reads the role the row holds NOW.
      await lockTargetAndActor(tx, targetId, actorUserId, 'update');
      const [target] = await tx
        .select({
          id: users.id,
          email: users.email,
          roleId: users.roleId,
          createdBy: users.createdBy,
          twoFactorEnabled: users.twoFactorEnabled,
          roleName: roles.roleName,
          roleScope: roles.scope,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .where(liveUser(eq(users.id, targetId)))
        .for('update', { of: users });

      if (!target) throw notFoundError();

      const targetRoleId = assertTargetUserVisible({
        isSelf: target.id === actorUserId,
        roleId: target.roleId,
        createdBy: target.createdBy,
        role: { roleName: target.roleName, scope: target.roleScope },
        actorUserId,
        scope,
      });

      // `resetTwoFactor` has no `Own` variant, so the `createdBy` narrowing never
      // fires; without this an actor refused a `PUT` on this id could still strip
      // its second factor.
      await validateRolePermissionScope(
        actorPermissions,
        targetRoleId,
        tx,
        'reachability'
      );

      await clearTwoFactorEnrolment(tx, targetId, { deletePasskeys: true });

      await revokePendingProofs(tx, targetId);
      // Every session, including the target's own: nothing that predates the
      // loss of a security control should survive it.
      await revokeOtherSessions(tx, targetId);

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'UPDATE',
        tableName: 'users',
        recordId: targetId,
        oldData: { twoFactorEnabled: target.twoFactorEnabled },
        newData: { twoFactorEnabled: false, twoFactorReset: true },
        meta: auditMeta,
      });
    });

    return apiSuccess({ message: twoFactorMsg.disabled });
  }
);
