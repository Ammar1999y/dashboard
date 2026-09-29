import type { AuthContext } from '../context';
import type { EntityID } from '@app/shared/types';

import { db } from '@/db';

import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { authenticationDenied } from '../errors';
import { resolveRequestSession } from '../session/request';
import { roleAllowsLogin } from '../user-eligibility';

export async function requireReauthSession(ctx: AuthContext) {
  const session = await resolveRequestSession(ctx);
  if (!session) throw authenticationDenied();
  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.id, session.userId),
    with: { role: true },
  });
  if (!user || !roleAllowsLogin(user.role)) throw authenticationDenied();
  return session;
}

/** Per user, not per IP: the budget that matters is guesses per account. */
export async function enforceReauthAttemptLimit(
  userId: EntityID
): Promise<void> {
  await enforceRateLimit({
    scope: 'dash.reauth',
    identifier: userIdentifier(userId),
    limit: 10,
    failClosed: true,
  });
}
