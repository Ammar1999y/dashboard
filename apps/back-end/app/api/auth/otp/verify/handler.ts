import type { Handler } from '@/lib/http/contract';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { OTP_ENABLED, verifyOtpSchema } from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { ensureMinDelay, otpMsg } from '@/lib/auth/messages';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { readJsonBody } from '@/lib/http/input';
import {
  apiSuccess,
  handleApiError,
  requireFeature,
} from '@/lib/http/response';
import { markContactVerified } from '@/lib/otp/contact';
import { collapseProofThrottle } from '@/lib/otp/throttle';
import { processOtpVerify } from '@/lib/otp/verify';
import {
  enforceOtpVerifyQuota,
  enforceRateLimit,
  ipIdentifier,
} from '@/lib/rate-limit';
import { activeUserWithContact, contactIdentifier } from '@/lib/users/contact';

import { sanitizeForLog } from '@/utils/log';

export const POST: Handler = async (ctx) => {
  // Before any DB work, so the floor covers the lookup too.
  const start = Date.now();
  try {
    requireFeature(OTP_ENABLED);

    // Per IP BEFORE the captcha, bounding the siteverify call and stopping one
    // IP spraying codes across identifiers past the per-identifier cap.
    await enforceRateLimit({
      scope: 'otp.verify.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk) {
      // Returned, not thrown: the collapse below would turn this 403 into 400.
      return handleApiError(
        new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN)
      );
    }

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

    // Thrown so the catch applies the same floor as the real path.
    if (!userData)
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

    const auditMeta = getAuditMeta(ctx);

    const onMissing = (): never => {
      // The user vanished or was deactivated mid-flow: logged apart from a
      // wrong code, answered with the same generic error.
      console.error(
        sanitizeForLog({
          msg: 'otp.verify.userVanished',
          userId: userData.id,
          channel,
        })
      );
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);
    };

    // OTP_AUTO_VERIFY flips the flag without a code, so a client that still
    // calls verify succeeds idempotently. Otherwise the flag flips inside the
    // verify transaction, after a real match, under the user row lock.
    try {
      await (OTP_AUTO_VERIFY
        ? withTransaction((tx) =>
            markContactVerified(tx, {
              userId: userData.id,
              channel,
              auditMeta,
              onMissing,
            })
          )
        : processOtpVerify({
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
          }));
    } catch (error) {
      // Proof-row state is account-dependent: only the pre-lookup limiters may
      // expose a 429 and Retry-After on this anonymous endpoint.
      throw collapseProofThrottle(error, otpMsg.invalidOrExpired);
    }

    await ensureMinDelay(Date.now() - start);

    return apiSuccess({
      message: otpMsg.verifySuccess(channel),
      data: { verified: true },
    });
  } catch (error) {
    await ensureMinDelay(Date.now() - start);

    // Unknown user, wrong code and missing proof answer one generic shape.
    // 429 keeps its headers, 503 surfaces so a fail-closed limiter outage is
    // not masked as a wrong code, and 500/422 pass through.
    if (
      error instanceof CustomError &&
      error.status !== HTTP_STATUS.TOO_MANY_REQUESTS &&
      error.status !== HTTP_STATUS.SERVICE_UNAVAILABLE &&
      error.status !== HTTP_STATUS.INTERNAL_ERROR &&
      error.status !== HTTP_STATUS.UNPROCESSABLE
    ) {
      const generic = new CustomError(
        otpMsg.invalidOrExpired,
        HTTP_STATUS.BAD_REQUEST
      );
      generic.responseHeaders = error.responseHeaders;
      return handleApiError(generic);
    }

    return handleApiError(error, otpMsg.verifyError);
  }
};
