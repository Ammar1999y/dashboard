import type { Executor } from '@/db';
import type { PermissionRows } from '@app/shared/permissions/matrix';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';

import { eq } from 'drizzle-orm';

import { rolePermissions } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { assertRowsWithinScope } from '@app/shared/permissions/scope';

import { notFoundError } from '@/lib/http/response';

import { holdsLocks } from './roles';

/**
 * `reachability` — "may this caller act on this target at all", answered 404.
 * `grant` — "may this caller confer these permissions", answered 403.
 *
 * The distinction is a disclosure boundary, not a style choice. Every
 * neighbouring unreachable-target gate answers **404 `MSG_NOT_FOUND`**, and
 * `handleApiError` passes a `CustomError`'s status through verbatim. A 403 on
 * reachability would tell an actor holding `users.view` + `users.edit` but NOT
 * `permissions.view` that an account exists and its role holds a permission
 * they do not — enough, one `PUT` per listed user, to reconstruct the relative
 * privilege ranking of every account without the grant that gates it.
 *
 * Required rather than defaulted: a new call site must decide which question it
 * is asking, because getting it wrong is silent in both directions.
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
    // Collapsed into the answer every other reachability gate gives, so a
    // caller cannot tell "outranks me" from "does not exist".
    throw notFoundError();
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
