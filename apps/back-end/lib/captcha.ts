import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import {
  CAPTCHA_HEADER,
  CAPTCHA_TOKEN_MAX_LENGTH,
} from '@app/shared/validation/auth';

import { createAdmission } from '@/lib/admission';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { serviceBusy } from '@/lib/http/response';

import { errorClassOf, logLine } from '@/utils/log';

import { getClientIp } from './http/client-ip';

// Cloudflare's always-pass secret:
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const SITEVERIFY_TIMEOUT_MS = 3000;

/**
 * Siteverify calls in flight. Bun runs at most 256 `fetch`es a process, in one
 * queue shared with SMS, WhatsApp, HIBP and Google, and any junk token costs a
 * call: uncapped, a flood of them times out those deliveries too. The queue
 * wait comes before the timeout's clock starts.
 */
export const SITEVERIFY_SLOTS = 64;
export const SITEVERIFY_QUEUE = 64;
const SITEVERIFY_MAX_WAIT_MS = 1000;
const CAPTCHA_BUSY_RETRY_AFTER_S = 5;

/** Not a refusal of the token: the caller has not been judged, so no 403. */
const captchaBusy = () => serviceBusy(CAPTCHA_BUSY_RETRY_AFTER_S);

const acquireSiteverify = createAdmission({
  slots: SITEVERIFY_SLOTS,
  queueLimit: SITEVERIFY_QUEUE,
  maxWaitMs: SITEVERIFY_MAX_WAIT_MS,
  refusal: captchaBusy,
});

function turnstileSecretKey(): string | undefined {
  return process.env.NODE_ENV === 'development'
    ? TEST_SECRET_KEY
    : process.env.TURNSTILE_SECRET_KEY;
}

/**
 * The hostnames a token must have been issued on. Without it, a token solved on
 * any site using the same sitekey passes. `undefined` under the test secret,
 * whose tokens carry Cloudflare's placeholder hostname.
 */
function turnstileHostnames(): string[] | undefined {
  return process.env.NODE_ENV === 'development'
    ? undefined
    : [new URL(PUBLIC_ORIGIN).hostname];
}

/**
 * Refusals that are ours or Cloudflare's, never the caller's: with a wrong
 * secret every captcha route answers 403 to every user. The token codes
 * (`invalid-input-response`, `timeout-or-duplicate`, ...) stay unlogged, since
 * anyone can produce them at will.
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
const OPERATOR_ERROR_CODES = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'bad-request',
  'internal-error',
]);

function logOperatorErrorCodes(data: unknown): void {
  if (typeof data !== 'object' || data === null || !('error-codes' in data))
    return;
  const codes = data['error-codes'];
  if (!Array.isArray(codes)) return;
  const operatorCodes = codes.filter(
    (code): code is string =>
      typeof code === 'string' && OPERATOR_ERROR_CODES.has(code)
  );
  if (operatorCodes.length > 0)
    logLine('error', {
      msg: 'captcha.siteverify failed',
      errorCodes: operatorCodes,
    });
}

/**
 * Fails closed on any error. Throws the busy 503 when siteverify is saturated,
 * before calling out.
 */
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

  const release = await acquireSiteverify();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      logLine('error', {
        msg: 'captcha.siteverify failed',
        status: response.status,
      });
      return false;
    }
    const data: unknown = await response.json();
    if (
      typeof data !== 'object' ||
      data === null ||
      !('success' in data) ||
      data.success !== true
    ) {
      logOperatorErrorCodes(data);
      return false;
    }
    const hostnames = turnstileHostnames();
    return (
      !hostnames ||
      ('hostname' in data &&
        typeof data.hostname === 'string' &&
        hostnames.includes(data.hostname))
    );
  } catch (error) {
    // Class only: the request body carries the secret and the token.
    logLine('error', {
      msg: 'captcha.siteverify failed',
      errorClass: errorClassOf(error),
      timedOut: controller.signal.aborted,
    });
    return false;
  } finally {
    clearTimeout(timeout);
    release();
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
 * A failed `verifyTurnstileRequest`, thrown by the binding gate
 * (`lib/http/admit.ts`) and the Better Auth mount
 * (`server/elysia/auth-mount.ts`) before any handler runs, so no handler's
 * status collapse or timing floor applies to it. It reveals nothing about an
 * account.
 */
export function captchaRefused(): CustomError {
  return new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);
}
