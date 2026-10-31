import type { Tx } from '@/db';
import type {
  PermissionObject,
  SessionMetadata,
} from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';
import type { SQL } from 'drizzle-orm';

import { eq, inArray, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { roles, sessions, users } from '@/db/schema';

import { sanitizePermissions } from '@app/shared/permissions/matrix';

import { activeUser, liveUser } from '@/lib/users/filters';

/**
 * Merges `patch` into the permission cache of every unexpired session whose
 * owner `owners` selects.
 *
 * The patch is the OBJECT, never its JSON text: `bun:sql` encodes a jsonb
 * parameter itself, so a pre-serialised string arrives as a jsonb string
 * scalar, on which `||` concatenates into an array instead of merging — see
 * `jsonb` in `db/schema.ts`.
 */
function patchSessionMetadata(tx: Tx, patch: SessionMetadata, owners: SQL) {
  return tx.execute(sql`
    UPDATE sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${patch}::jsonb,
        updated_at = NOW()
    WHERE ${owners}
    AND expires_at > NOW()
  `);
}

/**
 * Rewrites the cached permissions of every live session holding this role, in
 * place: its users stay signed in.
 */
export async function refreshRoleSessions(
  roleId: EntityID,
  tx: Tx,
  precomputed?: {
    roleName: string;
    roleScope: string;
    permissions: Partial<PermissionObject>;
  }
): Promise<void> {
  let roleName: string;
  let roleScope: string;
  let permissions: Partial<PermissionObject>;

  if (precomputed) {
    roleName = precomputed.roleName;
    roleScope = precomputed.roleScope;
    permissions = precomputed.permissions;
  } else {
    const roleData = await tx.query.roles.findFirst({
      where: (rolesTable, { eq }) => eq(rolesTable.id, roleId),
      columns: { roleName: true, scope: true },
      with: {
        rolePermissions: {
          columns: { pageName: true, permissions: true },
        },
      },
    });

    if (!roleData) return;

    roleName = roleData.roleName;
    roleScope = roleData.scope;
    permissions = sanitizePermissions(roleData.rolePermissions);
  }

  await patchSessionMetadata(
    tx,
    { roleName, roleScope, permissions, roleId },
    inArray(
      sessions.userId,
      tx
        .select({ id: users.id })
        .from(users)
        .where(activeUser(eq(users.roleId, roleId)))
    )
  );
}

export async function refreshUserSessions(
  userId: EntityID,
  tx: Tx
): Promise<void> {
  const userData = await tx.query.users.findFirst({
    where: liveUser(eq(users.id, userId)),
    columns: { roleId: true },
    with: {
      role: {
        columns: { roleName: true, scope: true },
        with: {
          rolePermissions: {
            columns: { pageName: true, permissions: true },
          },
        },
      },
    },
  });

  if (!userData?.role) return;

  const permissions = sanitizePermissions(userData.role.rolePermissions);

  await patchSessionMetadata(
    tx,
    {
      roleId: userData.roleId,
      roleName: userData.role.roleName,
      roleScope: userData.role.scope,
      permissions,
    },
    eq(sessions.userId, userId)
  );
}

/**
 * `refreshUserSessions` for a caller holding no lock. The user and role rows
 * are share-locked first (users → roles, the canonical order), so a user or
 * role edit in flight commits before the read, and this write cannot land a
 * snapshot older than the edit's own refresh.
 */
export async function resyncUserSessions(userId: EntityID): Promise<void> {
  await withTransaction(async (tx) => {
    const [user] = await tx
      .select({ roleId: users.roleId })
      .from(users)
      .where(eq(users.id, userId))
      .for('share');
    if (user?.roleId)
      await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.id, user.roleId))
        .for('share');

    await refreshUserSessions(userId, tx);
  });
}
