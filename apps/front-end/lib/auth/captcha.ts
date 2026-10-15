import { CAPTCHA_HEADER } from '@app/shared/validation/auth';

/** Tokens a request was built with: the server spends each one on sight. */
const sentTokens = new Set<string>();

/**
 * Splits a captcha form's values into what the request sends: the token goes in
 * its header, never the body, which the server's schemas do not list. Spread
 * the result into `mutate` or `authRequest`.
 */
export function withCaptcha<T extends { captcha: string }>({
  captcha,
  ...data
}: T) {
  sentTokens.add(captcha);
  return { data, headers: { [CAPTCHA_HEADER]: captcha } };
}

/**
 * Whether `token` went out with a request, and so needs replacing. Answers
 * `true` once per token: the widget asks when a submit settles, and a submit
 * that failed client-side validation never sent the token it still holds.
 */
export const takeSentCaptcha = (token: string) => sentTokens.delete(token);

/** Whether a request's headers carry a captcha token. */
export const carriesCaptcha = (headers: Record<string, string> | undefined) =>
  headers !== undefined && CAPTCHA_HEADER in headers;
