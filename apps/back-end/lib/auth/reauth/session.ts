import type { AuthContext } from '../context';
import type { EntityID } from '@app/shared/types';

import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { authenticationDenied } from '../errors';
import { resolveRequestSession } from '../session/request';

/**
 * Liveness is the path policy's (`LIVE_SESSION_PATHS`), and deactivating a role
 * revokes its members' sessions. What a proof mints re-checks role eligibility
 * under the user lock (`lockSessionOwner`).
 */
export async function requireReauthSession(ctx: AuthContext) {
  const session = await resolveRequestSession(ctx);
  if (!session) throw authenticationDenied();
  return session;
}

/**
 * Per user, not per IP: the budget that matters is guesses per account. One
 * budget for every re-authentication proof, `POST /api/dash/auth/reauth`'s
 * included.
 */
export const REAUTH_ATTEMPT_LIMIT = {
  scope: 'dash.reauth',
  limit: 10,
  failClosed: true,
} as const;

export async function enforceReauthAttemptLimit(
  userId: EntityID
): Promise<void> {
  await enforceRateLimit({
    ...REAUTH_ATTEMPT_LIMIT,
    identifier: userIdentifier(userId),
  });
}
