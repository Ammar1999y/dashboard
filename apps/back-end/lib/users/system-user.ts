import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { roles, users } from '@/db/schema';

import { PHONE_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_CREATE_ERROR } from '@app/shared/messages/common';
import {
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';

import { insertCredentialAccount } from '@/lib/auth/credential-account';
import { generateUuidV7 } from '@/lib/id';
import { writeRoleMatrix } from '@/lib/permissions/roles';

export const FIRST_ADMINISTRATOR_LOCK = 'users.first-administrator';

/** Held until the caller's transaction ends. */
export async function lockFirstAdministrator(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${FIRST_ADMINISTRATOR_LOCK}))`
  );
}

/**
 * A deactivated administrator counts, so the bootstrap cannot become a way to
 * mint a second one; recovering a locked-out deployment is a database task.
 */
export async function administratorExists(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(roles.scope, ROLE_SCOPE.SYSTEM), isNull(users.deletedAt)))
    .limit(1);
  return row !== undefined;
}

/**
 * A `system` role holding every permission, one active user on it, and that
 * user's credential account. Contacts stay unverified: nothing has proven them.
 */
export async function insertSystemUser(
  tx: Tx,
  input: {
    name: string;
    email: string;
    phoneNumber?: string | null;
    passwordHash: string;
  }
): Promise<{ userId: EntityID; roleId: EntityID }> {
  // Named by the user's id, not the email: the role is inserted first, so an
  // email clash would surface as the role name's, which no mapping answers 409.
  const userId = generateUuidV7();

  const [systemRole] = await tx
    .insert(roles)
    .values({
      roleName: `system-${userId}`,
      scope: ROLE_SCOPE.SYSTEM,
      isActive: true,
    })
    .returning({ id: roles.id });

  if (!systemRole)
    throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

  await writeRoleMatrix(
    tx,
    systemRole.id,
    DEFAULT_PAGE_PERMISSIONS.map((page) => ({
      name: page.name,
      permissions: Object.fromEntries(
        page.availablePermissions.map((action) => [action, true])
      ),
    })),
    { prune: false }
  );

  const [newUser] = await tx
    .insert(users)
    .values({
      id: userId,
      name: input.name,
      email: input.email,
      roleId: systemRole.id,
      isActive: true,
      ...(PHONE_ENABLED &&
        input.phoneNumber && { phoneNumber: input.phoneNumber }),
    })
    .returning({ id: users.id });

  if (!newUser)
    throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

  await insertCredentialAccount(tx, newUser.id, input.passwordHash);

  return { userId: newUser.id, roleId: systemRole.id };
}
