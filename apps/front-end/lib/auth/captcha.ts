import { CAPTCHA_HEADER } from '@app/shared/validation/auth';

/** Tokens a request was built with: the server spends each one on sight. */
const sentTokens = new Set<string>();

/** The header a captcha token travels in; from here on it counts as sent. */
export function captchaHeaders(token: string) {
  sentTokens.add(token);
  return { [CAPTCHA_HEADER]: token };
}

/**
 * Splits a captcha form's values into what the auth client sends: the token
 * goes in its header, never the body, which the server's schemas do not list.
 * `api()` takes the token as its `captcha` option instead.
 */
export function withCaptcha<T extends { captcha: string }>({
  captcha,
  ...data
}: T) {
  return { data, headers: captchaHeaders(captcha) };
}

/**
 * Whether `token` went out with a request, and so needs replacing. Answers
 * `true` once per token: the widget asks when a submit settles, and a submit
 * that failed client-side validation never sent the token it still holds.
 */
export const takeSentCaptcha = (token: string) => sentTokens.delete(token);
