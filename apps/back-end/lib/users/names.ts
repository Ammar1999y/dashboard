import type { Executor } from '@/db';
import type { EntityID } from '@app/shared/types';

import { inArray } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

import { liveUser } from './filters';

/**
 * One query for the display names of `ids`, answered as a lookup. A missing
 * or soft-deleted user has no name; a deactivated one keeps theirs.
 */
export async function userNames(
  ids: Iterable<EntityID | null>,
  executor: Executor = db
): Promise<(id: EntityID | null) => string | null> {
  const wanted = [
    ...new Set([...ids].filter((id): id is EntityID => id !== null)),
  ];
  if (wanted.length === 0) return () => null;
  const rows = await executor
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(liveUser(inArray(users.id, wanted)));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return (id) => (id === null ? null : (names.get(id) ?? null));
}
