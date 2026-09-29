import type { RecoveryVerdict } from '@/lib/auth/recovery/second-factor';

import { and, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { accounts, users } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import {
  OTP_ENABLED,
  recoveryCompleteSchema,
} from '@app/shared/validation/otp';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { credentialAccountOf } from '@/lib/auth/credential-account';
import { otpMsg, twoFactorMsg } from '@/lib/auth/messages';
import { checkPasswordCompromise } from '@/lib/auth/password/compromise';
import { hashPassword } from '@/lib/auth/password/hash';
import {
  consumeRecoveryGrant,
  resolveRecoveryOption,
  spendRecoveryAttempt,
} from '@/lib/auth/recovery/grant';
import { verifyRecoveryFactor } from '@/lib/auth/recovery/second-factor';
import {
  revokeOtherSessions,
  revokePendingProofs,
} from '@/lib/auth/session/rotation';
import { lockUser } from '@/lib/auth/user-eligibility';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, requireFeature } from '@/lib/http/response';
import { withTimingFloor } from '@/lib/http/timing-floor';
import { invalidOrExpiredCode } from '@/lib/otp/throttle';
import { otpGuessWasEvaluated } from '@/lib/otp/verify';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

/**
 * Forgot-password step 3, the half that makes the reset a two-possession
 * operation.
 *
 * ⚠️ The grant is NOT sufficient alone: it proves the recovery contact and
 * nothing else. The password is written only after a factor from the grant's
 * issued set — excluding the contact the recovery code arrived on — is proven
 * in this request, against the SAME grant, consumed in the write's transaction.
 */
export const POST = withTimingFloor(
  otpMsg.passwordResetError,
  async (ctx, floor) => {
    requireFeature(OTP_ENABLED);

    await enforceRateLimit({
      scope: 'forgot.complete.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 30,
      failClosed: true,
    });

    const {
      grant: grantToken,
      option: requested,
      code: suppliedCode,
      newPassword,
    } = await readJsonBody(ctx, recoveryCompleteSchema, {
      message: otpMsg.invalidInput,
    });

    const resolved = await resolveRecoveryOption(grantToken, requested);
    if (!resolved) throw invalidOrExpiredCode();
    const { grant, option } = resolved;

    // Screened and hashed before the attempt is spent: neither depends on the
    // account, so a rejection here costs the user nothing.
    await checkPasswordCompromise(newPassword);
    const hashedPassword = await hashPassword(newPassword);

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        phoneNumber: users.phoneNumber,
      })
      .from(users)
      .where(
        and(
          eq(users.id, grant.userId),
          eq(users.isActive, true),
          isNull(users.deletedAt)
        )
      )
      .limit(1);
    if (!user) throw invalidOrExpiredCode();

    const attempt = await spendRecoveryAttempt(grantToken);
    if (!attempt.ok)
      throw new CustomError(
        twoFactorMsg.tooManyAttempts,
        HTTP_STATUS.BAD_REQUEST
      );

    const auditMeta = getAuditMeta(ctx);
    let verdict: RecoveryVerdict;
    try {
      verdict = await verifyRecoveryFactor(
        option,
        user,
        suppliedCode,
        auditMeta
      );
    } catch (caught) {
      // The sign-in challenge's rule: only a code COMPARED and lost is a guess.
      // A missing proof row or a fault before the comparison is refunded.
      await (otpGuessWasEvaluated(caught)
        ? attempt.recordFailure()
        : attempt.restore());
      throw caught;
    }

    if (verdict !== 'matched') {
      // The same distinction as a verdict: `rejected` was compared,
      // `unavailable` never got that far.
      await (verdict === 'rejected'
        ? attempt.recordFailure()
        : attempt.restore());
      throw new CustomError(twoFactorMsg.invalidCode, HTTP_STATUS.BAD_REQUEST);
    }

    // One transaction: the grant is spent, the password written, and every
    // session, pending proof and trusted device goes with it — the person
    // recovering may not be the account's owner.
    const written = await withTransaction(async (tx) => {
      // The user row before the grant rows: every other writer of this user's
      // `verifications` rows already holds the user lock.
      await lockUser(tx, user.id);

      if (!(await consumeRecoveryGrant(tx, grantToken, user.id))) return false;

      const [account] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(credentialAccountOf(user.id))
        .for('update');
      if (!account) return false;

      await tx
        .update(accounts)
        .set({ password: hashedPassword })
        .where(eq(accounts.id, account.id));

      await revokeOtherSessions(tx, user.id);
      await revokePendingProofs(tx, user.id);

      await auditLog(tx, {
        userId: user.id,
        userEmail: user.email,
        action: 'UPDATE',
        tableName: 'accounts',
        recordId: account.id,
        oldData: {},
        newData: {
          passwordReset: true,
          recoverySecondFactor: option.id,
          recoveryExcludedContact: grant.excludeContactKind,
        },
        meta: auditMeta,
      });
      return true;
    });

    if (!written) throw invalidOrExpiredCode();

    await floor();
    return apiSuccess({
      message: otpMsg.passwordResetSuccess,
      data: { reset: true },
    });
  }
);
