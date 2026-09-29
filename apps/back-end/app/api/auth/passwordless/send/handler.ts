import { PASSWORDLESS_ENABLED } from '@app/shared/config';
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
 * Passwordless login step 1: a sign-in code (purpose=passwordless_login) to the
 * chosen channel. Always a REAL code — OTP_AUTO_VERIFY never auto-issues a
 * login. Known and unknown identifiers get the same response and timing.
 */
export const POST = withTimingFloor(otpMsg.sendError, async (ctx, floor) => {
  requireFeature(OTP_ENABLED && PASSWORDLESS_ENABLED);

  // Per IP BEFORE the captcha, bounding the siteverify call. It runs before
  // any lookup, so its 429 reveals nothing and propagates as-is.
  await enforceRateLimit({
    scope: 'passwordless.send.ip',
    identifier: ipIdentifier(ctx.headers),
    limit: 60,
    failClosed: true,
  });

  if (!(await verifyTurnstileRequest(ctx.headers)))
    return handleApiError(captchaRefused());

  await sendAnonymousOtp(ctx, {
    surface: 'passwordless',
    purpose: 'passwordless_login',
    failureLog: 'passwordless.send.failed',
  });

  await floor();
  return apiSuccess({ message: otpMsg.sendSuccess, data: ANONYMOUS_SEND_DATA });
});
