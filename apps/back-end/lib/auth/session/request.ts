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
 * ⚠️ The one enrolment-vs-sign-in discriminator: the plugin reads a session
 * FIRST, so a caller holding both is an enrolment. `getSessionFromCtx` memoises,
 * so the plugin reuses this answer.
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
