import type { EntityID } from '@app/shared/types';
import type { ReauthMethod } from '@app/shared/validation/reauth';

import { CustomError } from '@app/shared/error-class';
import { REAUTH_REQUIRED_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_REAUTH_REQUIRED } from '@app/shared/messages/auth';
import { isTwoFactorMethodEnabled } from '@app/shared/validation/two-factor';

import { reauth, session, twoFactor } from '../store';

/** The server's `ADMIN_REAUTH_MAX_AGE_S`. */
export const REAUTH_WINDOW_S = 900;

/**
 * The server's `availableReauthMethods`: the password, and a passkey for an
 * account that holds one where the deployment serves them.
 */
export function reauthMethodsOf(userId: EntityID): ReauthMethod[] {
  const holdsPasskey = (twoFactor.find(userId)?.passkeys.length ?? 0) > 0;
  return holdsPasskey && isTwoFactorMethodEnabled('passkey')
    ? ['password', 'passkey']
    : ['password'];
}

/**
 * The server's `hasAdminReauth`: a window opened by this session's own user,
 * not yet expired, by a method the account still offers. A new sign-in is a
 * new session, so it starts without one.
 */
export function hasReauthWindow(): boolean {
  const current = session.get();
  const granted = reauth.get();
  return (
    !!current &&
    !!granted &&
    granted.sessionId === current.session.id &&
    granted.userId === current.user.id &&
    Date.parse(granted.expiresAt) > Date.now() &&
    reauthMethodsOf(current.user.id).includes(granted.method)
  );
}

/** The server's `requireReauthWindow`: 401 with the code the client prompts on. */
export function requireReauthWindow(): void {
  if (!hasReauthWindow())
    throw new CustomError(
      MSG_REAUTH_REQUIRED,
      HTTP_STATUS.UNAUTHORIZED,
      REAUTH_REQUIRED_CODE
    );
}

/** The server's `mintAdminReauth`, for the signed-in session. */
export function openReauthWindow(method: ReauthMethod): void {
  const current = session.get();
  if (!current) return;
  reauth.set({
    sessionId: current.session.id,
    userId: current.user.id,
    method,
    expiresAt: new Date(Date.now() + REAUTH_WINDOW_S * 1000).toISOString(),
  });
}
