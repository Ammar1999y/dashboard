import { eq } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { roles, users } from '@/db/schema';

import { resetUserTwoFactor } from '@app/shared/api/users';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { MSG_UPDATE_ERROR } from '@app/shared/messages/common';
import { holdsActionOn } from '@app/shared/permissions/scope';

import { auditLog, getAuditMeta } from '@/lib/audit';
import {
  revokeOtherSessions,
  revokePendingProofs,
} from '@/lib/auth/session/rotation';
import { clearTwoFactorEnrolment } from '@/lib/auth/two-factor/methods';
import { bind } from '@/lib/http/binding';
import { notFoundError } from '@/lib/http/response';
import { liveUser } from '@/lib/users/filters';
import { lockTargetAndActor } from '@/lib/users/lock-order';
import {
  assertTargetUserReachable,
  assertTargetUserVisibleUnlocked,
} from '@/lib/users/target-user';

/**
 * Clears a user's second factor entirely — the only path back for a user who
 * lost every factor, since password recovery refuses to defeat one.
 *
 * `resetTwoFactor` is its own permission rather than part of `edit`: it is the
 * one grant that removes a security control from someone else's account.
 *
 * ⚠️ Deliberately NOT gated on the configured method list: stored 2FA state
 * outlives the configuration that created it, and under an empty list this
 * reset is the only exit for an account still holding it.
 */
export const resetUserTwoFactorBinding = bind(resetUserTwoFactor, {
  permission: {
    resource: 'users',
    action: 'resetTwoFactor',
    // Not the cookie cache: this revokes a security control, so the grant
    // behind it has to be the current one. The re-authentication window the
    // policy asks for covers the SELF target too: `assertTargetUserVisible`
    // exempts self from both its narrowings, so without it a hijacked
    // administrator session disarms its own second factor by POSTing its own id.
    forceDB: true,
  },
  rateLimit: {
    scope: 'users.two-factor.reset',
    limit: 10,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_UPDATE_ERROR,
  detail: {
    summary: 'Clear a user’s two-factor enrolment',
    description: 'This operation requires re-authentication.',
    tags: ['Users'],
  },
  handler: async ({ params, actor, meta }) => {
    const {
      session,
      userId: actorUserId,
      scope,
      permissions: actorPermissions,
    } = actor;
    const targetId = params.id;

    const auditMeta = getAuditMeta(meta);

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
          roleScope: roles.scope,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .where(liveUser(eq(users.id, targetId)))
        .for('update', { of: users });

      if (!target) throw notFoundError();

      const isSelf = target.id === actorUserId;
      // Reachable, not only visible: `resetTwoFactor` has no `Own` variant, so
      // the `createdBy` narrowing never fires, and without the role check an
      // actor refused a `PUT` on this id could still strip its second factor.
      try {
        await assertTargetUserReachable(tx, {
          isSelf,
          roleId: target.roleId,
          createdBy: target.createdBy,
          role: { scope: target.roleScope },
          actorUserId,
          scope,
          actorPermissions,
        });
      } catch (error) {
        // `resetTwoFactor` needs no `view`, so unlike its siblings this route
        // can be refused a user the caller cannot read: that one stays a 404,
        // or the 403 would tell the caller it exists.
        const readable =
          isSelf ||
          holdsActionOn(
            actorPermissions,
            'users',
            'view',
            target.createdBy,
            actorUserId
          );
        if (
          !readable &&
          error instanceof CustomError &&
          error.status === HTTP_STATUS.FORBIDDEN
        )
          throw notFoundError();
        throw error;
      }

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

    return { message: twoFactorMsg.disabled, data: null };
  },
});
