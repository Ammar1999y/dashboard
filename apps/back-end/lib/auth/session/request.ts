import type { AuthContext } from '../context';
import type { EntityID } from '@app/shared/types';

import { getSessionFromCtx } from 'better-auth/api';

import { validID } from '@app/shared/utils';

export interface RequestSession {
  userId: EntityID;
  sessionId: string;
  /** `audit_logs.user_email` is NOT NULL, and every lifecycle write audits. */
  userEmail: string;
}

/**
 * The session behind this request, resolved the way the library resolves it.
 *
 * ⚠️ The one discriminator for every path that serves both enrolment and
 * sign-in. The plugin's `verifyTwoFactor` reads a session FIRST and only falls
 * back to the challenge cookie, so a caller holding both is an enrolment to it;
 * anything of ours that branches on the cookie instead guards the other branch
 * — the one where the caller also holds a live session for that user.
 *
 * `getSessionFromCtx` memoises onto `ctx.context.session`, so calling it here
 * makes the plugin reuse this answer rather than recompute one that can differ.
 */
export async function resolveRequestSession(
  ctx: AuthContext
): Promise<RequestSession | null> {
  const resolved = await getSessionFromCtx(ctx).catch(() => null);
  const userId = validID(resolved?.user.id);
  const sessionId = resolved?.session.id;
  const userEmail = resolved?.user.email;
  if (
    !userId ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    typeof userEmail !== 'string'
  )
    return null;
  return { userId, sessionId, userEmail };
}
