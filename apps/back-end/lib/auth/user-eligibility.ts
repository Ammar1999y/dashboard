import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { SQL } from 'drizzle-orm';

import { eq } from 'drizzle-orm';

import { roles, users } from '@/db/schema';

import { REQUIRE_ROLE_FOR_LOGIN } from '@app/shared/permissions/constants';

import { compareCodeUnits } from '@/utils/text';

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
 * First in the canonical lock order: users → everything else. `no key update`
 * serialises with every other locker the same way, but lets an insert that
 * references the user through a foreign key (a session, an audit row) proceed.
 */
export async function lockUser(
  tx: Tx,
  userId: EntityID,
  strength: 'update' | 'no key update' = 'update'
): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for(strength);
}

/**
 * ⚠️ An audit row's foreign key takes `KEY SHARE` on its actor. A write that
 * audits as someone other than the user it locks takes that lock first
 * instead: taken last, it lands after locks a holder of the actor's row may be
 * waiting for.
 */
export async function lockActor(tx: Tx, actorId: EntityID): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, actorId))
    .for('key share');
}

/**
 * An administrative write on another user: the target at `strength`, the actor
 * as `lockActor` takes it, both first and in id order, so two administrators
 * acting on each other queue instead of deadlocking.
 */
export async function lockTargetAndActor(
  tx: Tx,
  targetId: EntityID,
  actorId: EntityID,
  strength: 'update' | 'share'
): Promise<void> {
  const lockTarget = () =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetId))
      .for(strength);
  if (targetId === actorId) await lockTarget();
  else if (compareCodeUnits(targetId, actorId) < 0) {
    await lockTarget();
    await lockActor(tx, actorId);
  } else {
    await lockActor(tx, actorId);
    await lockTarget();
  }
}
