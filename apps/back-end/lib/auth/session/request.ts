import type { AuthContext } from '../context';
import type { EntityID } from '@app/shared/types';

import { getSessionFromCtx } from 'better-auth/api';

import { validID } from '@app/shared/utils';

import { recordingFaults } from '../context';

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
 *
 * A fault reading the session is rethrown: `getSessionFromCtx` answers it as no
 * session, which would refuse a signed-in caller or route it to sign-in.
 */
export async function resolveRequestSession(
  ctx: AuthContext
): Promise<RequestSession | null> {
  const watched = recordingFaults(ctx.context);
  const resolved = await getSessionFromCtx({
    ...ctx,
    context: watched.context,
  });
  const fault = watched.fault();
  if (fault) throw fault.error;
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
