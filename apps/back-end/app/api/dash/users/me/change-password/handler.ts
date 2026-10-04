import type { VerifiedPasswordProof } from '@/lib/auth/login-guard';

import { and, eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { accounts, users } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_UPDATE_ERROR } from '@app/shared/messages/common';
import { userMsg } from '@app/shared/messages/users';
import { changePasswordSchema } from '@app/shared/validation/auth';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { CREDENTIAL_PROVIDER_ID } from '@/lib/auth/credential';
import { credentialAccountOf } from '@/lib/auth/credential-account';
import { verifyLoginAttempt } from '@/lib/auth/login-guard';
import { checkPasswordCompromise } from '@/lib/auth/password/compromise';
import { hashPassword, verifyPassword } from '@/lib/auth/password/hash';
import { requireReauthWindow } from '@/lib/auth/reauth/window';
import {
  revokeOtherSessions,
  revokePendingProofs,
} from '@/lib/auth/session/rotation';
import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';
import { insufficientPermissions } from '@/lib/permissions/checker';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import { asCurrentPasswordIncorrect } from '@/lib/users/current-password';
import { liveUser } from '@/lib/users/filters';

export const POST = withApiErrors(MSG_UPDATE_ERROR, async (ctx) => {
  const { session, userId, sessionId } = await requireSession(ctx);

  await enforceRateLimit({
    scope: 'users.me.change-password.post',
    identifier: userIdentifier(userId),
    limit: 5,
    failClosed: true,
  });

  if (!(await verifyTurnstileRequest(ctx.headers))) throw captchaRefused();

  const input = await readJsonBody(ctx, changePasswordSchema);

  // The `currentPassword` branch only: that value is verified against the
  // stored hash below, so plaintext equality with it IS equality with the
  // stored password, at no Argon2 cost. The window branch has no plaintext and
  // is checked against the hash instead.
  if (input.currentPassword === input.newPassword)
    throw new CustomError(
      userMsg.newPasswordSameAsCurrent,
      HTTP_STATUS.BAD_REQUEST
    );

  await checkPasswordCompromise(input.newPassword);

  const auditMeta = getAuditMeta(ctx);

  // Argon2 stays outside the mutation transaction; the proof is consumed with
  // a compare-and-swap condition under the account row lock.
  let passwordProof: VerifiedPasswordProof;
  try {
    if (input.currentPassword === undefined) {
      await requireReauthWindow(userId, sessionId);
      const [credential] = await db
        .select({ accountId: accounts.id, expectedHash: accounts.password })
        .from(accounts)
        .where(credentialAccountOf(userId));
      if (!credential?.expectedHash)
        throw new CustomError(
          userMsg.passwordUpdateFailed,
          HTTP_STATUS.BAD_REQUEST
        );

      // The same-password rule against the only thing this branch has, the
      // stored hash; otherwise an open window lets a caller "change" to the
      // existing password, revoking every session and proof and auditing a
      // change that did not happen. One Argon2 verify, the cost of the other
      // branch.
      if (
        await verifyPassword({
          hash: credential.expectedHash,
          password: input.newPassword,
        })
      )
        throw new CustomError(
          userMsg.newPasswordSameAsCurrent,
          HTTP_STATUS.BAD_REQUEST
        );

      passwordProof = {
        accountId: credential.accountId,
        expectedHash: credential.expectedHash,
      };
    } else
      passwordProof = await verifyLoginAttempt({
        userId,
        password: input.currentPassword,
        skipTimingGuard: true,
        returnPasswordProof: true,
        auditMeta,
        purpose: 'reauth_change_password',
      });
  } catch (error) {
    throw asCurrentPasswordIncorrect(error);
  }

  const hashedPassword = await hashPassword(input.newPassword);

  await withTransaction(async (tx) => {
    // Liveness rechecked after hashing, so a concurrent suspension cannot
    // commit a credential change. The user lock comes first because rotation
    // writes the user after the credential.
    const [freshUser] = await tx
      .select({ roleId: users.roleId, isActive: users.isActive })
      .from(users)
      .where(liveUser(eq(users.id, userId)))
      .for('update');

    if (!freshUser || !freshUser.isActive || !freshUser.roleId)
      throw insufficientPermissions();

    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, passwordProof.accountId),
          eq(accounts.userId, userId),
          eq(accounts.providerId, CREDENTIAL_PROVIDER_ID),
          eq(accounts.password, passwordProof.expectedHash)
        )
      )
      .for('update');

    if (!account)
      throw new CustomError(
        userMsg.passwordUpdateFailed,
        HTTP_STATUS.BAD_REQUEST
      );

    await tx
      .update(accounts)
      .set({ password: hashedPassword })
      .where(eq(accounts.id, account.id));

    if (sessionId) await revokeOtherSessions(tx, userId, sessionId);

    // Every pending proof goes too: an unconsumed forgot-password or
    // passwordless proof would otherwise reset the NEW password. Trusted
    // devices are KEPT — this caller proved the old password on a live session,
    // so they are the owner; recovery, where they may not be, revokes them.
    await revokePendingProofs(tx, userId, null, 'keep');

    await auditLog(tx, {
      userId,
      userEmail: session.user.email,
      action: 'UPDATE',
      tableName: 'accounts',
      recordId: account.id,
      oldData: {},
      newData: { passwordChanged: true },
      meta: auditMeta,
    });
  });

  return apiSuccess({ message: userMsg.passwordChanged });
});
