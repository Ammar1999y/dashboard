/**
 * Single-use re-authentication grants bound to one user. Their rows are valued
 * by the user id, which is how credential rotation revokes them.
 */
import type { AuthContext } from '../context';
import type { EntityID } from '@app/shared/types';

import { HTTP_STATUS, MSG_INVALID_CREDENTIALS } from '@app/shared/api-messages';
import { validID } from '@app/shared/utils';

import { authAuditMeta, bodyRecord } from '../context';
import { authError, reauthenticationRequired } from '../errors';
import { resolveRequestSession } from '../session/request';
import { expiresIn, randomToken, reauthGrantKey } from '../verifications';
import { verifyReauthPassword } from './password';
import { hasAdminReauth } from './window';

const GRANT_BYTES = 24;

/** Long enough for a WebAuthn ceremony a user has to walk through, and no longer. */
const REAUTH_GRANT_MAX_AGE_S = 600;

type ReauthPurpose = 'two_factor_enrolment';

export async function mintReauthGrant(
  ctx: AuthContext,
  params: { userId: EntityID; purpose: ReauthPurpose }
): Promise<string> {
  const token = randomToken(GRANT_BYTES);
  await ctx.context.internalAdapter.createVerificationValue({
    value: params.userId,
    identifier: reauthGrantKey(params.purpose, token),
    expiresAt: expiresIn(REAUTH_GRANT_MAX_AGE_S),
  });
  return token;
}

/**
 * Spends the grant, and answers `false` for every reason it could not be spent —
 * absent, expired, another user's, another purpose's, already used.
 */
export async function consumeReauthGrant(
  ctx: AuthContext,
  params: { userId: EntityID; purpose: ReauthPurpose; token: unknown }
): Promise<boolean> {
  if (typeof params.token !== 'string' || params.token.length === 0)
    return false;

  const consumed = await ctx.context.internalAdapter
    .consumeVerificationValue(reauthGrantKey(params.purpose, params.token))
    .catch(() => null);
  if (!consumed || consumed.expiresAt <= new Date()) return false;
  return validID(consumed.value) === params.userId;
}

/**
 * The password boundary for app-owned 2FA endpoints, which never reach
 * `password.verify` and so get no proof from `path-policy.ts`: a supplied
 * password, or an open window on this user's own session.
 */
export async function requireReauthPassword(
  ctx: AuthContext,
  userId: EntityID
): Promise<void> {
  const supplied = bodyRecord(ctx).password;
  if (supplied === undefined) {
    const session = await resolveRequestSession(ctx);
    if (
      session?.userId === userId &&
      (await hasAdminReauth(session.sessionId, userId))
    )
      return;
    throw reauthenticationRequired();
  }
  if (!(await verifyReauthPassword(userId, supplied, authAuditMeta(ctx))))
    throw authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);
}
