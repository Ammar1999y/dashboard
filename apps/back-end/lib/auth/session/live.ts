import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import { sessions, users } from '@/db/schema';

import { HTTP_STATUS, MSG_LOGIN_REQUIRED } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { validID } from '@app/shared/utils';

import { lockEligibleAuthUser } from '../user-eligibility';

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
    .where(
      and(
        eq(sessions.id, validSessionId),
        eq(sessions.userId, userId),
        gt(sessions.expiresAt, sql`now()`),
        isNull(users.deletedAt),
        eq(users.isActive, true)
      )
    );

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
