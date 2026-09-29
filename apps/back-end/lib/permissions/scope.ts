import type { ActorPermissions } from './checker';
import type { PagePermissions, PermissionRows } from './matrix';
import type { Executor } from '@/db';
import type {
  DashboardPage,
  PermissionAction,
} from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';

import { eq } from 'drizzle-orm';

import { rolePermissions } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { SUPERSEDING_ACTION } from '@app/shared/permissions/constants';

import { notFoundError } from '@/lib/http/response';

import { holdsLocks } from './roles';

/**
 * Does the actor hold `action`, directly or through supersession?
 *
 * `PERMISSION_ACTIONS` states the rule: holding `view` makes `viewOwn`
 * redundant, and likewise for edit/delete. An exact-match comparison would
 * refuse an actor with `edit` on all records when granting `editOwn`, a strict
 * subset of what they already hold.
 */
function actorHoldsAction(
  actorPagePerms: Partial<Record<PermissionAction, boolean>> | undefined,
  action: string
): boolean {
  if (actorPagePerms?.[action as PermissionAction] === true) return true;
  const superseding = SUPERSEDING_ACTION[action];
  return !!superseding && actorPagePerms?.[superseding] === true;
}

export function validatePermissionScope(
  actorPermissions: ActorPermissions,
  targetPermissions: PagePermissions
): void {
  for (const target of targetPermissions) {
    const actorPagePerms = actorPermissions[target.name];

    for (const [action, granted] of Object.entries(target.permissions)) {
      if (granted === true && !actorHoldsAction(actorPagePerms, action))
        throw new CustomError(
          MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS,
          HTTP_STATUS.FORBIDDEN
        );
    }
  }
}

/** `validatePermissionScope` over stored `role_permissions` rows. */
export function assertRowsWithinScope(
  actorPermissions: ActorPermissions,
  rows: PermissionRows
): void {
  validatePermissionScope(
    actorPermissions,
    rows.map((p) => ({
      name: p.pageName as DashboardPage,
      permissions: (p.permissions || {}) as Record<string, boolean>,
    }))
  );
}

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
 * The `reachability` answer, for a call site that already holds the target's
 * permission rows and must not re-read them — `DELETE
 * /api/dash/permissions/:id` reads them `FOR SHARE` for its own audit payload.
 */
export function collapseToNotFound(error: unknown): never {
  if (!(error instanceof CustomError)) throw error;
  throw notFoundError();
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

  if (perms.length === 0) return;

  try {
    assertRowsWithinScope(actorPermissions, perms);
  } catch (error) {
    if (check === 'grant') throw error;
    // Collapsed into the answer every other reachability gate gives, so a
    // caller cannot tell "outranks me" from "does not exist".
    collapseToNotFound(error);
  }
}
