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
  async (ctx, startFloor) => {
    requireFeature(OTP_ENABLED);

    // Before the captcha, bounding siteverify and code spraying across identifiers.
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

    const deadline = startFloor();
    const [userData] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(activeUserWithContact(channel, identifier))
      .limit(1);

    if (!userData) throw invalidOrExpiredCode();

    const auditMeta = getAuditMeta(ctx);

    const onMissing = (): never => {
      // User vanished mid-flow: logged apart, answered generically.
      logSanitized('error', {
        msg: 'otp.verify.userVanished',
        userId: userData.id,
        channel,
      });
      throw invalidOrExpiredCode();
    };

    // Under OTP_AUTO_VERIFY a client that still calls verify succeeds idempotently.
    await verifyOtpOrAutoVerify({
      userId: userData.id,
      userEmail: userData.email,
      channel,
      purpose: 'verify_contact',
      identifier,
      code,
      auditMeta,
      deadline,
      onVerified: (tx) =>
        markContactVerified(tx, {
          userId: userData.id,
          channel,
          auditMeta,
          onMissing,
        }),
    });

    return apiSuccess({
      message: otpMsg.verifySuccess(channel),
      data: { verified: true },
    });
  },
  (error) => collapseAnonymousVerifyError(error, otpMsg.invalidOrExpired)
);
