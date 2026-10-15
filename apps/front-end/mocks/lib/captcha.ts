import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import { CAPTCHA_HEADER } from '@app/shared/validation/auth';

import { spentCaptchas } from '../store';

/** Enough to catch a reuse within a session; the oldest are forgotten. */
const REMEMBERED = 100;

/**
 * The server's `verifyTurnstileRequest` on a route behind a captcha: a token the
 * verifier has seen once is refused (403) the next time, whatever became of the
 * request that carried it, a refusal for a missing re-authentication included.
 * A request with no token passes, so a test that does not exercise the captcha
 * need not send one; the widget always does.
 */
export function requireUnspentCaptcha(request: Request): void {
  const token = request.headers.get(CAPTCHA_HEADER);
  if (!token) return;
  const spent = spentCaptchas.get();
  if (spent.includes(token))
    throw new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);
  spentCaptchas.set([...spent, token].slice(-REMEMBERED));
}
