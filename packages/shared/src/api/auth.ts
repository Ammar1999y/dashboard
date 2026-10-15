import { OTP_PROOF_THROTTLE_CODE } from '../error-codes';
import {
  anonymousOtpSentSchema,
  ladderOtpSentSchema,
  reauthGrantSchema,
  recoveryResultSchema,
  resetDoneSchema,
  verifiedSchema,
} from '../responses/auth';
import { adminReauthSchema } from '../validation/auth';
import {
  recoveryCompleteSchema,
  recoverySecondFactorSendSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from '../validation/otp';
import { endpoint } from './endpoint';

/**
 * Answers alike for a real and an invented identifier, so no refusal names the
 * field or branch that failed.
 */
const ANONYMOUS = {
  auth: 'public',
  captcha: true,
  reauth: false,
  rateLimited: true,
  checksPassword: false,
} as const;

/**
 * No captcha: only a recovery grant reaches these, and it follows a solved
 * captcha and a verified code.
 */
const RECOVERY_GRANT = { ...ANONYMOUS, captcha: false } as const;

export const sendOtp = endpoint({
  method: 'POST',
  path: '/api/auth/otp/send',
  body: sendOtpSchema,
  status: 200,
  response: anonymousOtpSentSchema,
  policy: ANONYMOUS,
});

export const verifyOtp = endpoint({
  method: 'POST',
  path: '/api/auth/otp/verify',
  body: verifyOtpSchema,
  status: 200,
  response: verifiedSchema,
  errors: { 400: {} },
  policy: ANONYMOUS,
});

export const sendPasswordlessCode = endpoint({
  method: 'POST',
  path: '/api/auth/passwordless/send',
  body: sendOtpSchema,
  status: 200,
  response: anonymousOtpSentSchema,
  policy: ANONYMOUS,
});

export const sendPasswordResetCode = endpoint({
  method: 'POST',
  path: '/api/auth/forgot-password/send',
  body: sendOtpSchema,
  status: 200,
  response: anonymousOtpSentSchema,
  policy: ANONYMOUS,
});

/** 403 only after a correct code: a second factor this flow cannot check. */
export const resetPassword = endpoint({
  method: 'POST',
  path: '/api/auth/forgot-password/reset',
  body: resetPasswordSchema,
  status: 200,
  response: recoveryResultSchema,
  errors: { 400: {}, 403: {} },
  policy: ANONYMOUS,
});

export const sendRecoverySecondFactorCode = endpoint({
  method: 'POST',
  path: '/api/auth/forgot-password/second-factor/send',
  body: recoverySecondFactorSendSchema,
  status: 200,
  response: ladderOtpSentSchema,
  errors: { 400: {}, 429: { codes: [OTP_PROOF_THROTTLE_CODE] } },
  policy: RECOVERY_GRANT,
});

export const completePasswordReset = endpoint({
  method: 'POST',
  path: '/api/auth/forgot-password/complete',
  body: recoveryCompleteSchema,
  status: 200,
  response: resetDoneSchema,
  errors: { 400: {}, 404: {}, 429: { codes: [OTP_PROOF_THROTTLE_CODE] } },
  policy: RECOVERY_GRANT,
});

/** A malformed body is answered like a wrong password: 401. */
export const reauthenticate = endpoint({
  method: 'POST',
  path: '/api/dash/auth/reauth',
  body: adminReauthSchema,
  status: 200,
  response: reauthGrantSchema,
  policy: {
    auth: 'session',
    captcha: false,
    reauth: false,
    rateLimited: true,
    checksPassword: true,
  },
});
