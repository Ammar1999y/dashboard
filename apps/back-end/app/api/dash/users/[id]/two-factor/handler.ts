import { and, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import {
  passkeys,
  roles,
  twoFactorCredentials,
  twoFactorMethods,
  users,
} from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { twoFactorMsg } from '@/lib/auth/messages';
import {
  revokeOtherSessions,
  revokePendingProofs,
} from '@/lib/auth/session/rotation';
import { requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { validateRolePermissionScope } from '@/lib/permissions/utils';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import { assertTargetUserVisible } from '@/lib/users/target-user';

/**
 * Clears a user's second factor entirely — the only path back for a user who
 * lost every factor, since password recovery refuses to defeat one.
 *
 * `resetTwoFactor` is its own permission rather than part of `edit`: it is the
 * one grant that removes a security control from someone else's account.
 */
export const POST = withApiErrors(MSG_UPDATE_ERROR, async (ctx) => {
  // ⚠️ Deliberately NOT gated on the configured method list: stored 2FA state
  // outlives the configuration that created it, and under an empty list this
  // reset is the only exit for an account still holding it.
  const targetId = requireId(
    ctx.params.id,
    MSG_NOT_FOUND,
    HTTP_STATUS.NOT_FOUND
  );

  const {
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

  // ADDITIVE, never authoritative, like `editUserAsAdmin`'s preflight: the
  // locked transaction re-reads the target and re-runs both gates, so this can
  // only refuse EARLIER.
  const [prefilter] = await db
    .select({
      id: users.id,
      roleId: users.roleId,
      createdBy: users.createdBy,
      roleName: roles.roleName,
      roleScope: roles.scope,
    })
    .from(users)
    .leftJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
    .limit(1);

  if (!prefilter) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  assertTargetUserVisible({
    isSelf: prefilter.id === actorUserId,
    roleId: prefilter.roleId,
    createdBy: prefilter.createdBy,
    role: { roleName: prefilter.roleName, scope: prefilter.roleScope },
    actorUserId,
    scope,
  });

  const auditMeta = getAuditMeta(ctx);

  await withTransaction(async (tx) => {
    // Locked first, keeping the canonical order (users -> everything else),
    // and joined so the authorization below reads the role the row holds NOW.
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
      .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
      .for('update', { of: users });

    if (!target) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

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
    if (actorPermissions)
      await validateRolePermissionScope(
        actorPermissions,
        targetRoleId,
        tx,
        'reachability'
      );

    await tx
      .delete(twoFactorMethods)
      .where(eq(twoFactorMethods.userId, targetId));
    await tx
      .delete(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, targetId));
    await tx.delete(passkeys).where(eq(passkeys.userId, targetId));
    await tx
      .update(users)
      .set({ twoFactorEnabled: false })
      .where(eq(users.id, targetId));

    await revokePendingProofs(tx, targetId);
    // Every session, including the target's own: nothing that predates the
    // loss of a security control should survive it.
    await revokeOtherSessions(tx, targetId);

    await auditLog(tx, {
      userId: targetId,
      userEmail: target.email,
      action: 'UPDATE',
      tableName: 'users',
      recordId: targetId,
      oldData: { twoFactorEnabled: target.twoFactorEnabled },
      newData: {
        twoFactorEnabled: false,
        twoFactorReset: true,
        // The rest of the row describes the target; this names the actor.
        resetBy: actorUserId,
      },
      meta: auditMeta,
    });
  });

  return apiSuccess({ message: twoFactorMsg.disabled });
});
