import type { RecoveryVerdict } from '@/lib/auth/recovery/second-factor';
import type { OfferedOption } from '@/lib/auth/two-factor/methods';

import { and, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { accounts, users } from '@/db/schema';

import {
  completePasswordReset,
  resetPassword,
  sendPasswordResetCode,
  sendRecoverySecondFactorCode,
} from '@app/shared/api/auth';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { otpMsg } from '@app/shared/messages/otp';
import { contactKindOf } from '@app/shared/validation/enums';
import { OTP_ENABLED } from '@app/shared/validation/otp';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { credentialAccountOf } from '@/lib/auth/credential-account';
import { checkPasswordCompromise } from '@/lib/auth/password/compromise';
import { hashPassword } from '@/lib/auth/password/hash';
import {
  consumeRecoveryGrant,
  issueRecoveryGrant,
  resolveRecoveryOption,
  spendRecoveryAttempt,
} from '@/lib/auth/recovery/grant';
import { verifyRecoveryFactor } from '@/lib/auth/recovery/second-factor';
import {
  revokeOtherSessions,
  revokePendingProofs,
} from '@/lib/auth/session/rotation';
import {
  defaultOption,
  readEnrolmentState,
  recoveryDefeatsTwoFactor,
  recoveryOptions,
} from '@/lib/auth/two-factor/methods';
import { sendTwoFactorCode } from '@/lib/auth/two-factor/otp';
import { lockUser } from '@/lib/auth/user-eligibility';
import { bind } from '@/lib/http/binding';
import { handleApiError } from '@/lib/http/response';
import {
  ANONYMOUS_SEND_DATA,
  sendAnonymousOtp,
} from '@/lib/otp/anonymous-send';
import { OTP_MAX_VERIFY_ATTEMPTS } from '@/lib/otp/limits';
import { invalidOrExpiredCode } from '@/lib/otp/throttle';
import { otpGuessWasEvaluated, processOtpVerify } from '@/lib/otp/verify';
import {
  enforceOtpVerifyQuota,
  enforceRateLimit,
  ipIdentifier,
} from '@/lib/rate-limit';
import {
  activeUserWithContact,
  contactIdentifier,
  contactOf,
} from '@/lib/users/contact';

import {
  COLLAPSED_BODY_REFUSALS,
  collapsedVerifyError,
  FIXED_BODY_REFUSAL,
  PUBLISHED_SEND_BODY,
} from './anonymous';

// Argon2id hashes per IP per minute. Must stay above the OTP verify quota, so a
// user retyping a code hits that quota first.
const RESET_HASH_BUDGET_PER_MINUTE = OTP_MAX_VERIFY_ATTEMPTS * 3;

/**
 * A refusal raised before the account lookup, answered as raised: the
 * collapse that hides an account's refusals has nothing to hide in it.
 */
class PreLookupRefusal extends Error {
  constructor(readonly refusal: CustomError) {
    super(refusal.message);
    this.name = 'PreLookupRefusal';
  }
}

// Safe to surface: only a valid code reaches the two-factor refusal.
const collapseResetError = collapsedVerifyError([HTTP_STATUS.FORBIDDEN]);

// Always a real code: OTP_AUTO_VERIFY never short-circuits recovery.
export const sendPasswordResetCodeBinding = bind(sendPasswordResetCode, {
  enabled: OTP_ENABLED,
  // Before the captcha, bounding siteverify; pre-lookup, so its 429 reveals nothing.
  rateLimit: { scope: 'forgot.send.ip', limit: 60, failClosed: true, by: 'ip' },
  timingFloor: true,
  refusals: FIXED_BODY_REFUSAL,
  failure: otpMsg.sendError,
  detail: {
    summary: 'Send a password-reset code',
    tags: ['Authentication'],
    publishedBody: PUBLISHED_SEND_BODY,
  },
  handler: async ({ body: input, meta }) => {
    await sendAnonymousOtp(input, meta.rawRequest, {
      startFloor: meta.startFloor,
      surface: 'recovery',
      purpose: 'forgot_password',
      failureLog: 'forgot.send.failed',
    });

    return { message: otpMsg.sendSuccess, data: ANONYMOUS_SEND_DATA };
  },
});

/**
 * ⚠️ With a second factor this does NOT write the password: it mints a recovery
 * grant, and `/forgot-password/complete` writes it against a proven factor.
 */
export const resetPasswordBinding = bind(resetPassword, {
  enabled: OTP_ENABLED,
  // Before the captcha, bounding siteverify; pre-lookup, so its 429 reveals nothing.
  rateLimit: {
    scope: 'forgot.reset.ip',
    limit: 60,
    failClosed: true,
    by: 'ip',
  },
  timingFloor: true,
  refusals: COLLAPSED_BODY_REFUSALS,
  failure: otpMsg.passwordResetError,
  mapError: (error) =>
    error instanceof PreLookupRefusal
      ? handleApiError(error.refusal)
      : collapseResetError(error),
  detail: {
    summary: 'Reset a forgotten password',
    description:
      'A 403 follows a correct code when every second factor the account has is one this flow cannot check or sits on the contact the code arrived on; the password is unchanged, and an administrator’s two-factor reset is the way back.',
    spentInput:
      'a retry with the same code can find it already spent; request a new code.',
    tags: ['Authentication'],
  },
  handler: async ({ body: input, meta }) => {
    const { channel, code, newPassword } = input;
    const identifier = contactIdentifier(input);

    await enforceOtpVerifyQuota({ channel, identifier, surface: 'recovery' });

    // Prices the HIBP call and hash below apart from admission, so cheap
    // refusals cannot spend the expensive allowance. Per IP: no existence oracle.
    await enforceRateLimit({
      scope: 'forgot.reset.work.ip',
      identifier: ipIdentifier(meta.headers),
      limit: RESET_HASH_BUDGET_PER_MINUTE,
      failClosed: true,
    });

    // Before the lookup, so account-independent, and outside the transaction,
    // so no row lock is held across Argon2id.
    try {
      await checkPasswordCompromise(newPassword);
    } catch (error) {
      if (error instanceof CustomError) throw new PreLookupRefusal(error);
      throw error;
    }
    const hashedPassword = await hashPassword(newPassword);

    const deadline = meta.startFloor();
    const [userData] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(activeUserWithContact(channel, identifier))
      .limit(1);

    if (!userData) throw invalidOrExpiredCode();

    const auditMeta = getAuditMeta(meta);
    const contactKind = contactKindOf(channel);
    // Acted on after commit: a failed grant mint must not un-consume the code.
    const pending: { secondFactor: OfferedOption[] | null } = {
      secondFactor: null,
    };

    await processOtpVerify({
      userId: userData.id,
      userEmail: userData.email,
      channel,
      purpose: 'forgot_password',
      identifier,
      code,
      auditMeta,
      deadline,
      onVerified: async (tx, matched) => {
        // Refused, not gated: a second factor on the contact this code
        // arrived on, or one this flow cannot check, proves nothing.
        if (await recoveryDefeatsTwoFactor(userData.id, contactKind, tx))
          throw new CustomError(
            otpMsg.recoveryBlockedByTwoFactor,
            HTTP_STATUS.FORBIDDEN
          );

        const state = await readEnrolmentState(userData.id, tx);
        if (state.enabled) {
          const options = recoveryOptions(state, contactKind);
          if (options.length > 0) {
            pending.secondFactor = options;
            await auditLog(tx, {
              userId: userData.id,
              userEmail: userData.email,
              action: 'UPDATE',
              tableName: 'verification_sessions',
              recordId: matched.verificationSessionId,
              oldData: {},
              newData: {
                recoveryProofVerified: true,
                recoverySecondFactorRequired: options.map(
                  (option) => option.id
                ),
              },
              meta: auditMeta,
            });
            return;
          }
        }

        const [account] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(credentialAccountOf(userData.id))
          .for('update');

        if (!account) throw invalidOrExpiredCode();

        await tx
          .update(accounts)
          .set({ password: hashedPassword })
          .where(eq(accounts.id, account.id));

        // The consumed proof survives as an auditable single-use record.
        await revokeOtherSessions(tx, userData.id);
        await revokePendingProofs(
          tx,
          userData.id,
          matched.verificationSessionId
        );

        await auditLog(tx, {
          userId: userData.id,
          userEmail: userData.email,
          action: 'UPDATE',
          tableName: 'accounts',
          recordId: account.id,
          oldData: {},
          newData: { passwordReset: true },
          meta: auditMeta,
        });
      },
    });

    if (pending.secondFactor) {
      const options = pending.secondFactor;
      const grant = await issueRecoveryGrant({
        userId: userData.id,
        excludeContactKind: contactKind,
        options,
      });
      return {
        message: otpMsg.recoverySecondFactorRequired,
        data: {
          reset: false as const,
          twoFactorRequired: true as const,
          grant,
          options,
          defaultMethod: defaultOption(options),
        },
      };
    }

    return {
      message: otpMsg.passwordResetSuccess,
      data: { reset: true as const },
    };
  },
});

/**
 * ⚠️ Destination from the user row, option from the grant's issued set, so
 * nothing can redirect a code. Its own send budget, or the anonymous
 * verification surface could exhaust a locked-out user's last channel.
 */
export const sendRecoverySecondFactorCodeBinding = bind(
  sendRecoverySecondFactorCode,
  {
    enabled: OTP_ENABLED,
    rateLimit: {
      scope: 'forgot.second-factor.send.ip',
      limit: 30,
      failClosed: true,
      by: 'ip',
    },
    refusals: FIXED_BODY_REFUSAL,
    failure: otpMsg.sendError,
    detail: {
      summary: 'Send the second-factor code for a password reset',
      tags: ['Authentication'],
    },
    handler: async ({ body: { grant: grantToken, option: requested } }) => {
      const resolved = await resolveRecoveryOption(grantToken, requested);
      if (!resolved) throw invalidOrExpiredCode();
      const { grant, option } = resolved;
      if (option.method !== 'otp' || !option.channel)
        throw invalidOrExpiredCode();

      const [user] = await db
        .select({ email: users.email, phoneNumber: users.phoneNumber })
        .from(users)
        .where(eq(users.id, grant.userId))
        .limit(1);
      const destination =
        user && contactOf(user, contactKindOf(option.channel));
      if (!destination) throw invalidOrExpiredCode();

      const { nextAllowedIn } = await sendTwoFactorCode({
        userId: grant.userId,
        channel: option.channel,
        destination,
        surface: 'recovery_second_factor',
      });

      return { message: otpMsg.sendSuccess, data: { nextAllowedIn } };
    },
  }
);

/**
 * ⚠️ The grant alone is NOT sufficient: the password is written only after a
 * factor from its issued set is proven here, and the grant is consumed in the
 * write's transaction.
 */
export const completePasswordResetBinding = bind(completePasswordReset, {
  enabled: OTP_ENABLED,
  rateLimit: {
    scope: 'forgot.complete.ip',
    limit: 30,
    failClosed: true,
    by: 'ip',
  },
  timingFloor: true,
  refusals: FIXED_BODY_REFUSAL,
  failure: otpMsg.passwordResetError,
  detail: {
    summary: 'Finish a password reset with a proven second factor',
    spentInput:
      'a retry with the same code can find it already spent; keep the grant and use a new one: request another code at `/api/auth/forgot-password/second-factor/send`, wait for the authenticator’s next code, or use another backup code.',
    tags: ['Authentication'],
  },
  handler: async ({ body, meta }) => {
    const {
      grant: grantToken,
      option: requested,
      code: suppliedCode,
      newPassword,
    } = body;

    const resolved = await resolveRecoveryOption(grantToken, requested);
    if (!resolved) throw invalidOrExpiredCode();
    const { grant, option } = resolved;

    // Before the attempt is spent, so a rejection here costs no attempt.
    await checkPasswordCompromise(newPassword);
    const hashedPassword = await hashPassword(newPassword);

    meta.startFloor();
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
        otpMsg.recoveryAttemptsExhausted,
        HTTP_STATUS.BAD_REQUEST
      );

    const auditMeta = getAuditMeta(meta);
    let verdict: RecoveryVerdict;
    try {
      verdict = await verifyRecoveryFactor(
        option,
        user,
        suppliedCode,
        auditMeta
      );
    } catch (caught) {
      // Only a code compared and lost is a guess; everything else is refunded.
      await (otpGuessWasEvaluated(caught)
        ? attempt.recordFailure()
        : attempt.restore());
      throw caught;
    }

    if (verdict !== 'matched') {
      await (verdict === 'rejected'
        ? attempt.recordFailure()
        : attempt.restore());
      throw new CustomError(twoFactorMsg.invalidCode, HTTP_STATUS.BAD_REQUEST);
    }

    // Trusted devices go too: the person recovering may not be the owner.
    let written: boolean;
    try {
      written = await withTransaction(async (tx) => {
        // Before the grant rows: every other writer of them holds the user lock.
        await lockUser(tx, user.id);

        if (!(await consumeRecoveryGrant(tx, grantToken, user.id)))
          return false;

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
    } catch (caught) {
      // Rolled back, so the grant survives and the attempt a matched factor
      // spent is owed back; a new code can then finish it.
      await attempt.restore();
      throw caught;
    }

    if (!written) throw invalidOrExpiredCode();

    return {
      message: otpMsg.passwordResetSuccess,
      data: { reset: true as const },
    };
  },
});
