import { PASSWORDLESS_ENABLED } from '@app/shared/config';
import { otpMsg } from '@app/shared/messages/otp';
import { OTP_ENABLED } from '@app/shared/validation/otp';

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

// Always a real code: OTP_AUTO_VERIFY never auto-issues a login.
export const POST = withTimingFloor(
  'POST /api/auth/passwordless/send',
  otpMsg.sendError,
  async (ctx, startFloor) => {
    requireFeature(OTP_ENABLED && PASSWORDLESS_ENABLED);

    // Before the captcha, bounding siteverify; pre-lookup, so its 429 reveals nothing.
    await enforceRateLimit({
      scope: 'passwordless.send.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      failClosed: true,
    });

    if (!(await verifyTurnstileRequest(ctx.headers)))
      return handleApiError(captchaRefused());

    await sendAnonymousOtp(ctx, {
      startFloor,
      surface: 'passwordless',
      purpose: 'passwordless_login',
      failureLog: 'passwordless.send.failed',
    });

    return apiSuccess({
      message: otpMsg.sendSuccess,
      data: ANONYMOUS_SEND_DATA,
    });
  }
);
