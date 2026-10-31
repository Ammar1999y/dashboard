import type { EntityID } from '@app/shared/types';

import { and, count, desc, eq, gt, ne, notInArray, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { sessions } from '@/db/schema';

import { lockUser } from '@/lib/users/lock-order';

import { logLine } from '@/utils/log';

import { revokeSessionsWhere } from './rotation';

/**
 * Rows, expired ones included: the sweep keeps an expired session 30 days, and
 * every revocation works through all of them. Room for daily one-day sign-ins
 * on a few devices across that grace.
 */
export const MAX_SESSIONS_PER_USER = 100;

/**
 * Keeps `created` and the user's newest other sessions up to the cap, live
 * before expired, and revokes the rest. `created` is kept by id, not by rank: a
 * clock stepped back would rank it below rows already stored. Eviction rather
 * than refusing the sign-in: a refusal would let anyone holding the password
 * lock the owner out.
 */
export async function evictSessionsBeyondCap(
  userId: EntityID,
  created: string
): Promise<void> {
  // A count on `idx_sessions_user_expires_created` on every sign-in; the
  // transaction and its user lock only once the cap is passed.
  const [held] = await db
    .select({ total: count() })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  if (!held || held.total <= MAX_SESSIONS_PER_USER) return;

  const evicted = await withTransaction(async (tx) => {
    await lockUser(tx, userId);
    const others = and(eq(sessions.userId, userId), ne(sessions.id, created));
    const kept = tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(others)
      .orderBy(
        desc(gt(sessions.expiresAt, sql`now()`)),
        desc(sessions.createdAt),
        desc(sessions.id)
      )
      .limit(MAX_SESSIONS_PER_USER - 1);
    return revokeSessionsWhere(tx, and(others, notInArray(sessions.id, kept)));
  });
  logLine('warn', {
    msg: 'session.capEvicted',
    userId,
    evicted: evicted.length,
    cap: MAX_SESSIONS_PER_USER,
  });
}
