import type { AuthContext } from '../context';

import { expireCookie } from 'better-auth/cookies';

/** The plugin's challenge verifiers read this marker apart from session issuance. */
export function expireDontRememberMarker(ctx: AuthContext): void {
  expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
}
