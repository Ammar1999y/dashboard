import type { SQL } from 'drizzle-orm';

import { and, eq, isNull } from 'drizzle-orm';

import { users } from '@/db/schema';

/** The `users` rows `identity` names that are not soft-deleted. */
export function liveUser(identity: SQL) {
  return and(identity, isNull(users.deletedAt));
}

/** `liveUser`, and not deactivated. */
export function activeUser(identity: SQL) {
  return and(identity, isNull(users.deletedAt), eq(users.isActive, true));
}
