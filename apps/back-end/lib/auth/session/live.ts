import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import { sessions, users } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';
import { validID } from '@app/shared/utils';

import { lockEligibleAuthUser } from '../user-eligibility';

/** For a query joining `users` on `sessions.user_id`. */
export function liveSessionCondition(sessionId: EntityID, userId: EntityID) {
  return and(
    eq(sessions.id, sessionId),
    eq(sessions.userId, userId),
    gt(sessions.expiresAt, sql`now()`),
    isNull(users.deletedAt),
    eq(users.isActive, true)
  );
}

/**
 * ⚠️ `auth.api.getSession` answers from the cookie cache, which outlives the
 * row and ignores `is_active` / `deleted_at`; an entry point skipping this
 * honours a revoked or suspended session until it expires.
 */
export async function assertLiveSession(
  sessionId: string | null | undefined,
  userId: EntityID
): Promise<EntityID> {
  const validSessionId = validID(sessionId);
  if (!validSessionId)
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(liveSessionCondition(validSessionId, userId));

  if (!row) throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
  return validSessionId;
}

export async function lockSessionOwner(
  tx: Tx,
  userId: EntityID,
  sessionId: string
) {
  const user = await lockEligibleAuthUser(tx, eq(users.id, userId));
  const [live] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        gt(sessions.expiresAt, new Date())
      )
    );
  return user && live ? user : null;
}
