import { OTP_ENABLED } from '@app/shared/validation/otp';

import { otpMsg } from '@/lib/auth/messages';
import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import {
  apiSuccess,
  handleApiError,
  requireFeature,
} from '@/lib/http/response';
import { withTimingFloor } from '@/lib/http/timing-floor';
import {
  ANONYMOUS_SEND_DATA,
  sendAnonymousOtp,
} from '@/lib/otp/anonymous-send';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

/**
 * Forgot-password step 1: a code (purpose=forgot_password) to the chosen
 * channel. Always a REAL code — OTP_AUTO_VERIFY never short-circuits recovery.
 * Known and unknown identifiers get the same response.
 */
export const POST = withTimingFloor(otpMsg.sendError, async (ctx, floor) => {
  requireFeature(OTP_ENABLED);

  // Per IP BEFORE the captcha, bounding the siteverify call; pre-lookup, so
  // its 429 reveals nothing.
  await enforceRateLimit({
    scope: 'forgot.send.ip',
    identifier: ipIdentifier(ctx.headers),
    limit: 60,
    failClosed: true,
  });

  if (!(await verifyTurnstileRequest(ctx.headers)))
    return handleApiError(captchaRefused());

  await sendAnonymousOtp(ctx, {
    surface: 'recovery',
    purpose: 'forgot_password',
    failureLog: 'forgot.send.failed',
  });

  await floor();
  return apiSuccess({ message: otpMsg.sendSuccess, data: ANONYMOUS_SEND_DATA });
});
