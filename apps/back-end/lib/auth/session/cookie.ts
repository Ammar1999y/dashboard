import type { AuthContext } from '../context';

import { expireCookie, setSessionCookie } from 'better-auth/cookies';

/**
 * Delivers a freshly minted session's cookie under the user's remember choice.
 * `setSessionCookie` SETS the "do not remember" marker and never clears it
 * when the answer changes, so the positive case has to.
 */
export async function deliverSessionCookie(
  ctx: AuthContext,
  issued: Parameters<typeof setSessionCookie>[1],
  rememberMe: boolean
): Promise<void> {
  await setSessionCookie(ctx, issued, !rememberMe);
  if (rememberMe) expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
}
