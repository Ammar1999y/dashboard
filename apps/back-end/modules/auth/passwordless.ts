import { sendPasswordlessCode } from '@app/shared/api/auth';
import { PASSWORDLESS_ENABLED } from '@app/shared/config';
import { otpMsg } from '@app/shared/messages/otp';
import { OTP_ENABLED } from '@app/shared/validation/otp';

import { bind } from '@/lib/http/binding';
import {
  ANONYMOUS_SEND_DATA,
  sendAnonymousOtp,
} from '@/lib/otp/anonymous-send';

import { FIXED_BODY_REFUSAL, PUBLISHED_SEND_BODY } from './anonymous';

// Always a real code: OTP_AUTO_VERIFY never auto-issues a login.
export const sendPasswordlessCodeBinding = bind(sendPasswordlessCode, {
  enabled: OTP_ENABLED && PASSWORDLESS_ENABLED,
  // Before the captcha, bounding siteverify; pre-lookup, so its 429 reveals nothing.
  rateLimit: {
    scope: 'passwordless.send.ip',
    limit: 60,
    failClosed: true,
    by: 'ip',
  },
  timingFloor: true,
  refusals: FIXED_BODY_REFUSAL,
  failure: otpMsg.sendError,
  detail: {
    summary: 'Send a passwordless sign-in code',
    tags: ['Authentication'],
    publishedBody: PUBLISHED_SEND_BODY,
  },
  handler: async ({ body: input, meta }) => {
    await sendAnonymousOtp(input, meta.rawRequest, {
      startFloor: meta.startFloor,
      surface: 'passwordless',
      purpose: 'passwordless_login',
      failureLog: 'passwordless.send.failed',
    });

    return { message: otpMsg.sendSuccess, data: ANONYMOUS_SEND_DATA };
  },
});
