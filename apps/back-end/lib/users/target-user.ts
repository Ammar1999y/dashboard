import type { Executor } from '@/db';
import type { PermissionObject } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';

import { HTTP_STATUS, MSG_NOT_FOUND } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import {
  isProtectedSystemRole,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';

export type RolePolicyShape = {
  roleName?: string | null;
  scope?: string | null;
} | null;

/**
 * The single definition of "which user rows this actor may act on", shared by
 * the user routes and their subresources: a subresource must never be
 * reachable when its parent is not.
 *
 * Returns the target's role id, already proved present.
 */
export function assertTargetUserVisible(opts: {
  isSelf: boolean;
  roleId: EntityID | null;
  createdBy: EntityID | null;
  role: RolePolicyShape;
  actorUserId: EntityID;
  scope: 'all' | 'own' | null;
}): EntityID {
  if (!opts.roleId) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  // Self is exempt: a system-role owner can still read their own account.
  if (!opts.isSelf && isProtectedSystemRole(opts.role))
    throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  if (
    !opts.isSelf &&
    opts.scope === 'own' &&
    opts.createdBy !== opts.actorUserId
  )
    throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  return opts.roleId;
}

/**
 * Non-throwing `validateRolePermissionScope`, for data that is omitted rather
 * than refused, so both paths ask the authority question the same way.
 */
export async function actorCoversTargetRole(
  actorPermissions: Partial<PermissionObject> | undefined,
  roleId: EntityID,
  executor: Executor
): Promise<boolean> {
  if (!actorPermissions) return true;
  try {
    await validateRolePermissionScope(
      actorPermissions,
      roleId,
      executor,
      'reachability'
    );
    return true;
  } catch (error) {
    // BOTH refusal shapes: 404 under `'reachability'`, 403 under `'grant'`.
    // Letting either escape turns a GET that omits session metadata into a
    // whole-request refusal.
    if (
      error instanceof CustomError &&
      (error.status === HTTP_STATUS.FORBIDDEN ||
        error.status === HTTP_STATUS.NOT_FOUND)
    )
      return false;
    throw error;
  }
}
