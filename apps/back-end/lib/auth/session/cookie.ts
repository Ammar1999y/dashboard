import type { AuthContext } from '../context';

import { expireCookie, setSessionCookie } from 'better-auth/cookies';

// `setSessionCookie` sets the "do not remember" marker but never clears it.
export async function deliverSessionCookie(
  ctx: AuthContext,
  issued: Parameters<typeof setSessionCookie>[1],
  rememberMe: boolean
): Promise<void> {
  await setSessionCookie(ctx, issued, !rememberMe);
  if (rememberMe) expireDontRememberMarker(ctx);
}

/** `onlyIfSent` skips the `Set-Cookie` when the request carries no marker. */
export function expireDontRememberMarker(
  ctx: AuthContext,
  options: { onlyIfSent?: boolean } = {}
): void {
  const marker = ctx.context.authCookies.dontRememberToken;
  if (options.onlyIfSent && ctx.getCookie(marker.name) === null) return;
  expireCookie(ctx, marker);
}
