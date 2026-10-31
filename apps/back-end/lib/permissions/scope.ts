import type { Executor } from '@/db';
import type { PermissionRows } from '@app/shared/permissions/matrix';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';

import { eq } from 'drizzle-orm';

import { rolePermissions } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { assertRowsWithinScope } from '@app/shared/permissions/scope';

import { insufficientPermissions } from './checker';
import { holdsLocks } from './roles';

/**
 * `reachability` — "may this caller act on this target at all".
 * `grant` — "may this caller confer these permissions".
 *
 * Both answer 403 and differ only in the message. Reachability is not hidden
 * behind a 404: the detail routes show the target's whole matrix to any holder
 * of the page's `view` or `viewOwn`, which `edit` and `delete` require. The
 * 2FA reset, which needs neither, answers 404 itself for a target the caller
 * cannot read.
 */
export type RoleScopeCheck = 'reachability' | 'grant';

/**
 * The `reachability` answer over the target role's permission rows, for a call
 * site that already holds them and must not re-read them.
 */
export function assertRowsReachable(
  actorPermissions: ActorPermissions,
  rows: PermissionRows
): void {
  try {
    assertRowsWithinScope(actorPermissions, rows);
  } catch (error) {
    if (!(error instanceof CustomError)) throw error;
    // Not the grant message: acting on a target grants nothing.
    throw insufficientPermissions();
  }
}

/** Under a `tx`, `FOR SHARE` so the role cannot be re-permissioned between this read and the caller's write. */
export async function validateRolePermissionScope(
  actorPermissions: ActorPermissions,
  roleId: EntityID,
  executor: Executor,
  check: RoleScopeCheck
): Promise<void> {
  const query = executor
    .select({
      pageName: rolePermissions.pageName,
      permissions: rolePermissions.permissions,
    })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  const perms = await (holdsLocks(executor) ? query.for('share') : query);

  if (check === 'grant') assertRowsWithinScope(actorPermissions, perms);
  else assertRowsReachable(actorPermissions, perms);
}
