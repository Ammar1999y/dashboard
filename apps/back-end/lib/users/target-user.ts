import type { Executor } from '@/db';
import type { ActorPermissions } from '@/lib/permissions/checker';
import type { RolePolicyTarget } from '@/lib/permissions/roles';
import type { AccessScope } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { notFoundError } from '@/lib/http/response';
import { isProtectedSystemRole } from '@/lib/permissions/roles';
import { validateRolePermissionScope } from '@/lib/permissions/scope';

interface TargetUserVisibility {
  isSelf: boolean;
  roleId: EntityID | null;
  createdBy: EntityID | null;
  role: RolePolicyTarget;
  actorUserId: EntityID;
  scope: AccessScope | null;
}

/**
 * The single definition of "which user rows this actor may act on", shared by
 * the user routes and their subresources: a subresource must never be
 * reachable when its parent is not.
 *
 * Returns the target's role id, already proved present.
 */
export function assertTargetUserVisible(opts: TargetUserVisibility): EntityID {
  if (!opts.roleId) throw notFoundError();

  // Self is exempt: a system-role owner can still read their own account.
  if (!opts.isSelf && isProtectedSystemRole(opts.role)) throw notFoundError();

  if (
    !opts.isSelf &&
    opts.scope === 'own' &&
    opts.createdBy !== opts.actorUserId
  )
    throw notFoundError();

  return opts.roleId;
}

/**
 * `assertTargetUserVisible`, then role authority over the target's role as
 * the same 404.
 */
export async function assertTargetUserReachable(
  executor: Executor,
  opts: TargetUserVisibility & {
    actorPermissions: ActorPermissions | undefined;
  }
): Promise<EntityID> {
  const roleId = assertTargetUserVisible(opts);
  if (opts.actorPermissions)
    await validateRolePermissionScope(
      opts.actorPermissions,
      roleId,
      executor,
      'reachability'
    );
  return roleId;
}

/**
 * Non-throwing `validateRolePermissionScope`, for data that is omitted rather
 * than refused, so both paths ask the authority question the same way.
 */
export async function actorCoversTargetRole(
  actorPermissions: ActorPermissions | undefined,
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
