import type { Executor, Tx } from '@/db';
import type {
  PermissionObject,
  SessionMetadata,
} from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';
import type { SQL } from 'drizzle-orm';

import { eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

import { liveUser } from '@/lib/users/filters';

import { sanitizePermissions } from './matrix';

/**
 * Merges `patch` into the permission cache of every unexpired session whose
 * owner `owners` selects.
 *
 * The patch is the OBJECT, never its JSON text: `bun:sql` encodes a jsonb
 * parameter itself, so a pre-serialised string arrives as a jsonb string
 * scalar, on which `||` concatenates into an array instead of merging — see
 * `jsonb` in `db/schema.ts`.
 */
function patchSessionMetadata(
  executor: Executor,
  patch: SessionMetadata,
  owners: SQL
) {
  return executor.execute(sql`
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
    sql`user_id IN (
      SELECT id FROM users WHERE role_id = ${roleId} AND deleted_at IS NULL AND is_active = true
    )`
  );
}

export async function refreshUserSessions(
  userId: EntityID,
  tx?: Tx
): Promise<void> {
  const executor: Executor = tx ?? db;

  const userData = await executor.query.users.findFirst({
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
    executor,
    {
      roleId: userData.roleId,
      roleName: userData.role.roleName,
      roleScope: userData.role.scope,
      permissions,
    },
    sql`user_id = ${userId}`
  );
}
