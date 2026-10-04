import type { OfferedOption } from '@/lib/auth/two-factor/methods';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { accounts, users } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import { contactKindOf } from '@app/shared/validation/enums';
import { OTP_ENABLED, resetPasswordSchema } from '@app/shared/validation/otp';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { credentialAccountOf } from '@/lib/auth/credential-account';
import { checkPasswordCompromise } from '@/lib/auth/password/compromise';
import { hashPassword } from '@/lib/auth/password/hash';
import { issueRecoveryGrant } from '@/lib/auth/recovery/grant';
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
import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import { readJsonBody } from '@/lib/http/input';
import {
  apiSuccess,
  handleApiError,
  requireFeature,
} from '@/lib/http/response';
import { withTimingFloor } from '@/lib/http/timing-floor';
import { OTP_MAX_VERIFY_ATTEMPTS } from '@/lib/otp/limits';
import {
  collapseAnonymousVerifyError,
  invalidOrExpiredCode,
} from '@/lib/otp/throttle';
import { processOtpVerify } from '@/lib/otp/verify';
import {
  enforceOtpVerifyQuota,
  enforceRateLimit,
  ipIdentifier,
} from '@/lib/rate-limit';
import { activeUserWithContact, contactIdentifier } from '@/lib/users/contact';

// Argon2id hashes per IP per minute. Must stay above the OTP verify quota, so a
// user retyping a code hits that quota first.
const RESET_HASH_BUDGET_PER_MINUTE = OTP_MAX_VERIFY_ATTEMPTS * 3;

/**
 * ⚠️ With a second factor this does NOT write the password: it mints a recovery
 * grant, and `/forgot-password/complete` writes it against a proven factor.
 */
export const POST = withTimingFloor(
  otpMsg.passwordResetError,
  async (ctx, startFloor) => {
    requireFeature(OTP_ENABLED);

    // Before the captcha, bounding siteverify; pre-lookup, so its 429 reveals nothing.
    await enforceRateLimit({
      scope: 'forgot.reset.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      failClosed: true,
    });

    if (!(await verifyTurnstileRequest(ctx.headers)))
      return handleApiError(captchaRefused());

    const input = await readJsonBody(ctx, resetPasswordSchema, {
      message: otpMsg.invalidInput,
    });

    const { channel, code, newPassword } = input;
    const identifier = contactIdentifier(input);

    await enforceOtpVerifyQuota({ channel, identifier, surface: 'recovery' });

    // Prices the HIBP call and hash below apart from admission, so cheap
    // refusals cannot spend the expensive allowance. Per IP: no existence oracle.
    await enforceRateLimit({
      scope: 'forgot.reset.work.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: RESET_HASH_BUDGET_PER_MINUTE,
      failClosed: true,
    });

    // Before the lookup, so account-independent, and outside the transaction,
    // so no row lock is held across Argon2id.
    try {
      await checkPasswordCompromise(newPassword);
    } catch (e) {
      if (e instanceof CustomError) return handleApiError(e);
      throw e;
    }
    const hashedPassword = await hashPassword(newPassword);

    const deadline = startFloor();
    const [userData] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(activeUserWithContact(channel, identifier))
      .limit(1);

    if (!userData) throw invalidOrExpiredCode();

    const auditMeta = getAuditMeta(ctx);
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
      return apiSuccess({
        message: otpMsg.recoverySecondFactorRequired,
        data: {
          reset: false,
          twoFactorRequired: true,
          grant,
          options,
          defaultMethod: defaultOption(options),
        },
      });
    }

    return apiSuccess({
      message: otpMsg.passwordResetSuccess,
      data: { reset: true },
    });
  },
  // Safe to surface: only a valid code reaches the two-factor refusal.
  (error) =>
    collapseAnonymousVerifyError(error, otpMsg.invalidOrExpired, [
      HTTP_STATUS.FORBIDDEN,
    ])
);
