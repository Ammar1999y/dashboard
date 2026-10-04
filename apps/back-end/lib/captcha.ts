import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import {
  CAPTCHA_HEADER,
  CAPTCHA_TOKEN_MAX_LENGTH,
} from '@app/shared/validation/auth';

import { logLine, logSanitized } from '@/utils/log';

import { getClientIp } from './http/client-ip';

// Cloudflare's always-pass secret:
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const SITEVERIFY_TIMEOUT_MS = 3000;

/** The one Turnstile secret choice, shared with Better Auth's captcha plugin. */
export function turnstileSecretKey(): string | undefined {
  return process.env.NODE_ENV === 'development'
    ? TEST_SECRET_KEY
    : process.env.TURNSTILE_SECRET_KEY;
}

/** Fails closed on any error. */
async function verifyTurnstileToken(
  token: string,
  remoteIp?: string | null
): Promise<boolean> {
  if (!token || token.length > CAPTCHA_TOKEN_MAX_LENGTH) return false;

  const secretKey = turnstileSecretKey();

  if (!secretKey) {
    logLine('error', {
      msg: 'captcha.secret missing',
      nodeEnv: process.env.NODE_ENV ?? null,
    });
    return false;
  }

  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null) return false;
    return 'success' in data && data.success === true;
  } catch (error) {
    logSanitized('error', error);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The remote IP comes only from `getClientIp`'s trusted proxy headers, never
 * from a client-supplied override, which would let a caller forge the IP
 * Turnstile scores.
 */
export async function verifyTurnstileRequest(
  headers: Headers
): Promise<boolean> {
  const token = headers.get(CAPTCHA_HEADER);
  if (!token) return false;
  return verifyTurnstileToken(token, getClientIp(headers));
}

/**
 * A failed `verifyTurnstileRequest`. It reveals nothing about an account, so
 * the anonymous OTP handlers RETURN it through `handleApiError` rather than
 * throw it: their status collapse never applies to it. It precedes the lookup,
 * so it answers without the timing floor.
 */
export function captchaRefused(): CustomError {
  return new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);
}
