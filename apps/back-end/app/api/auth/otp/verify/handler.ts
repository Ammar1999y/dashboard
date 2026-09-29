import { db } from '@/db';
import { users } from '@/db/schema';

import { OTP_ENABLED, verifyOtpSchema } from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { otpMsg } from '@/lib/auth/messages';
import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import { readJsonBody } from '@/lib/http/input';
import {
  apiSuccess,
  handleApiError,
  requireFeature,
} from '@/lib/http/response';
import { withTimingFloor } from '@/lib/http/timing-floor';
import { markContactVerified } from '@/lib/otp/contact';
import {
  collapseAnonymousVerifyError,
  collapseProofThrottle,
  invalidOrExpiredCode,
} from '@/lib/otp/throttle';
import { verifyOtpOrAutoVerify } from '@/lib/otp/verify';
import {
  enforceOtpVerifyQuota,
  enforceRateLimit,
  ipIdentifier,
} from '@/lib/rate-limit';
import { activeUserWithContact, contactIdentifier } from '@/lib/users/contact';

import { logSanitized } from '@/utils/log';

export const POST = withTimingFloor(
  otpMsg.verifyError,
  async (ctx, floor) => {
    requireFeature(OTP_ENABLED);

    // Per IP BEFORE the captcha, bounding the siteverify call and stopping one
    // IP spraying codes across identifiers past the per-identifier cap.
    await enforceRateLimit({
      scope: 'otp.verify.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      failClosed: true,
    });

    if (!(await verifyTurnstileRequest(ctx.headers)))
      return handleApiError(captchaRefused());

    const input = await readJsonBody(ctx, verifyOtpSchema, {
      message: otpMsg.invalidInput,
    });

    const { channel, code } = input;
    const identifier = contactIdentifier(input);

    await enforceOtpVerifyQuota({
      channel,
      identifier,
      surface: 'verify_contact',
    });

    const [userData] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(activeUserWithContact(channel, identifier))
      .limit(1);

    // Thrown, so the floor pads it like the real path.
    if (!userData) throw invalidOrExpiredCode();

    const auditMeta = getAuditMeta(ctx);

    const onMissing = (): never => {
      // The user vanished or was deactivated mid-flow: logged apart from a
      // wrong code, answered with the same generic error.
      logSanitized('error', {
        msg: 'otp.verify.userVanished',
        userId: userData.id,
        channel,
      });
      throw invalidOrExpiredCode();
    };

    // OTP_AUTO_VERIFY flips the flag without a code, so a client that still
    // calls verify succeeds idempotently. Otherwise the flag flips inside the
    // verify transaction, after a real match, under the user row lock.
    try {
      await verifyOtpOrAutoVerify({
        userId: userData.id,
        userEmail: userData.email,
        channel,
        purpose: 'verify_contact',
        identifier,
        code,
        auditMeta,
        onVerified: (tx) =>
          markContactVerified(tx, {
            userId: userData.id,
            channel,
            auditMeta,
            onMissing,
          }),
      });
    } catch (error) {
      // Proof-row state is account-dependent: only the pre-lookup limiters may
      // expose a 429 and Retry-After on this anonymous endpoint.
      throw collapseProofThrottle(error, otpMsg.invalidOrExpired);
    }

    await floor();
    return apiSuccess({
      message: otpMsg.verifySuccess(channel),
      data: { verified: true },
    });
  },
  (error) => collapseAnonymousVerifyError(error, otpMsg.invalidOrExpired)
);
