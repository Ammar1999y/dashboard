import type { Handler } from '@/lib/http/contract';

import { db } from '@/db';
import { users } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { PASSWORDLESS_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { contactKindOf } from '@app/shared/validation/enums';
import { OTP_ENABLED, sendOtpSchema } from '@app/shared/validation/otp';

import { ensureMinDelay, otpMsg } from '@/lib/auth/messages';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { enqueueAfterResponse } from '@/lib/http/after-response';
import { readJsonBody } from '@/lib/http/input';
import {
  apiSuccess,
  handleApiError,
  requireFeature,
} from '@/lib/http/response';
import { CONTACT_LABEL } from '@/lib/otp/content';
import { processOtpSend } from '@/lib/otp/send';
import { OTP_BASE_RESEND_DELAY_S } from '@/lib/otp/throttle';
import {
  enforceOtpSurfaceSendQuota,
  enforceRateLimit,
  ipIdentifier,
} from '@/lib/rate-limit';
import { activeUserWithContact, contactIdentifier } from '@/lib/users/contact';

import { sanitizeForLog } from '@/utils/log';

const GENERIC_SEND_DATA = { nextAllowedIn: OTP_BASE_RESEND_DELAY_S };

/**
 * Passwordless login step 1: a sign-in code (purpose=passwordless_login) to the
 * chosen channel. Always a REAL code — OTP_AUTO_VERIFY never auto-issues a
 * login. Known and unknown identifiers get the same response and timing.
 */
export const POST: Handler = async (ctx) => {
  const start = Date.now();
  try {
    // The machinery has to exist AND this entry point has to be switched on.
    requireFeature(OTP_ENABLED && PASSWORDLESS_ENABLED);

    // Per IP BEFORE the captcha, bounding the siteverify call. It runs before
    // any lookup, so its 429 reveals nothing and propagates as-is.
    await enforceRateLimit({
      scope: 'passwordless.send.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      return handleApiError(
        new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN)
      );

    const input = await readJsonBody(ctx, sendOtpSchema, {
      message: otpMsg.invalidInput,
    });

    const { channel } = input;
    const identifier = contactIdentifier(input);

    await enforceOtpSurfaceSendQuota({
      channel,
      destination: identifier,
      surface: 'passwordless',
    });

    const genericResponse = () =>
      apiSuccess({ message: otpMsg.sendSuccess, data: GENERIC_SEND_DATA });

    const [userData] = await db
      .select({ id: users.id })
      .from(users)
      .where(activeUserWithContact(channel, identifier))
      .limit(1);

    if (!userData) {
      await ensureMinDelay(Date.now() - start);
      return genericResponse();
    }

    try {
      await processOtpSend({
        userId: userData.id,
        identifier,
        channel,
        purpose: 'passwordless_login',
        sendTo: identifier,
        entityName: CONTACT_LABEL[contactKindOf(channel)],

        deferDelivery: (task) => enqueueAfterResponse(ctx.rawRequest, task),
      });
    } catch (error) {
      console.error(sanitizeForLog({ msg: 'passwordless.send.failed', error }));
    }

    await ensureMinDelay(Date.now() - start);
    return genericResponse();
  } catch (error) {
    await ensureMinDelay(Date.now() - start);

    return handleApiError(error, otpMsg.sendError);
  }
};
