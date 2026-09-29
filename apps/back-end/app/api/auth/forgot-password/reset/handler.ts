import type { OfferedOption } from '@/lib/auth/two-factor/methods';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { accounts, users } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { contactKindOf } from '@app/shared/validation/enums';
import { OTP_ENABLED, resetPasswordSchema } from '@app/shared/validation/otp';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { credentialAccountOf } from '@/lib/auth/credential-account';
import { otpMsg } from '@/lib/auth/messages';
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

/**
 * Argon2id hashes one address may buy per minute on this route, sized against
 * the process's hashing capacity rather than a request count. Floored by a real
 * reset: a user working through a mistyped code must meet the OTP quota before
 * this, and three verify cycles leave room for that one plus a fresh start.
 */
const RESET_HASH_BUDGET_PER_MINUTE = OTP_MAX_VERIFY_ATTEMPTS * 3;

/**
 * Forgot-password step 2: the code (purpose=forgot_password) is verified and,
 * in the same transaction, the new password set and ALL the user's sessions
 * revoked. Always a real code. Failures collapse to one generic error so the
 * endpoint cannot enumerate accounts.
 *
 * ⚠️ For an account with a second factor this DOES NOT write the password: a
 * recovery code proves one contact, and no single possession may satisfy both
 * proofs. It mints a short-lived recovery grant instead, and
 * `/forgot-password/complete` writes the password against a proven factor.
 */
export const POST = withTimingFloor(
  otpMsg.passwordResetError,
  async (ctx, floor) => {
    requireFeature(OTP_ENABLED);

    // Per IP BEFORE the captcha, bounding the siteverify call; pre-lookup, so
    // its 429 reveals nothing.
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

    // The pre-proof work, priced apart from the request that carries it: an
    // outbound HIBP request and an Argon2id hash run for any valid body, before
    // the lookup, deliberately (see below). Its own scope rather than a heavier
    // `cost` on the admission counter, so cheap refusals cannot consume the
    // expensive allowance. Per IP and account-independent: no existence oracle.
    await enforceRateLimit({
      scope: 'forgot.reset.work.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: RESET_HASH_BUDGET_PER_MINUTE,
      failClosed: true,
    });

    // Screened and hashed BEFORE the lookup, which keeps them account-independent,
    // and outside the transaction, so no row lock is held across Argon2id. A
    // compromised password is answered as-is: it reveals nothing about the
    // account.
    try {
      await checkPasswordCompromise(newPassword);
    } catch (e) {
      if (e instanceof CustomError) return handleApiError(e);
      throw e;
    }
    const hashedPassword = await hashPassword(newPassword);

    const [userData] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(activeUserWithContact(channel, identifier))
      .limit(1);

    if (!userData) throw invalidOrExpiredCode();

    const auditMeta = getAuditMeta(ctx);
    const contactKind = contactKindOf(channel);
    // Set inside the proof transaction and acted on after it commits: a failure
    // to mint the grant must not roll back the consumption of a presented code.
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
      onVerified: async (tx, matched) => {
        // Refused, not gated: when every second factor reaches the contact
        // this code arrived on, or is one this flow cannot check, requiring it
        // proves nothing. Inside the proof transaction, so the decision and
        // the write cannot separate.
        if (await recoveryDefeatsTwoFactor(userData.id, contactKind, tx))
          throw new CustomError(
            otpMsg.recoveryBlockedByTwoFactor,
            HTTP_STATUS.FORBIDDEN
          );

        // The second-factor branch. Nothing about the password is written here.
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

        // Every session goes, and every pending proof but the one being
        // consumed, which survives as an auditable single-use record.
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
      await floor();
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

    await floor();
    return apiSuccess({
      message: otpMsg.passwordResetSuccess,
      data: { reset: true },
    });
  },
  // The two-factor refusal must reach the user, who holds a CORRECT code; safe
  // because only a valid code reaches it.
  (error) =>
    collapseAnonymousVerifyError(error, otpMsg.invalidOrExpired, [
      HTTP_STATUS.FORBIDDEN,
    ])
);
