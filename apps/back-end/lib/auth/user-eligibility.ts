import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { SQL } from 'drizzle-orm';

import { eq } from 'drizzle-orm';

import { roles, users } from '@/db/schema';

import { REQUIRE_ROLE_FOR_LOGIN } from '@app/shared/permissions/constants';

export function roleAllowsLogin(
  role: Pick<typeof roles.$inferSelect, 'isActive'> | null | undefined
) {
  return role ? role.isActive : !REQUIRE_ROLE_FOR_LOGIN;
}

/** The role half, for a caller that already holds the locked user row. */
export async function roleAllowsLoginFor(
  tx: Tx,
  roleId: EntityID | null
): Promise<boolean> {
  const [role] = roleId
    ? await tx
        .select({ isActive: roles.isActive })
        .from(roles)
        .where(eq(roles.id, roleId))
        .for('share')
    : [];
  return roleAllowsLogin(role);
}

// Rotation and sign-in admission serialize on the user before reading role liveness.
export async function lockEligibleAuthUser(tx: Tx, where: SQL) {
  const [user] = await tx.select().from(users).where(where).for('update');
  if (!user?.isActive || user.deletedAt) return null;
  return (await roleAllowsLoginFor(tx, user.roleId)) ? user : null;
}

/**
 * Locks the user row first, as every mutation of a user's dependent rows does,
 * so the canonical lock order (users → everything else) holds.
 */
export async function lockUser(tx: Tx, userId: EntityID): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
}
