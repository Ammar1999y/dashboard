import type { Executor, Tx } from '@/db';
import type { RolePolicyTarget } from '@/lib/permissions/roles';
import type { AccessScope } from '@app/shared/permissions/constants';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';

import { eq } from 'drizzle-orm';

import { roles, users } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';

import { notFoundError } from '@/lib/http/response';
import { isProtectedSystemRole } from '@/lib/permissions/roles';
import { validateRolePermissionScope } from '@/lib/permissions/scope';

import { liveUser } from './filters';

interface TargetUserVisibility {
  isSelf: boolean;
  roleId: EntityID | null;
  createdBy: EntityID | null;
  role: RolePolicyTarget;
  actorUserId: EntityID;
  scope: AccessScope | null;
}

// Shared with subresources: one must never be reachable when its parent is not.
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
 * `assertTargetUserVisible` over an unlocked read, for a write that locks the
 * target before its authoritative checks: a caller the target is hidden from
 * gets its 404 without holding the row. It takes no lock, so it cannot join a
 * lock cycle, and the locked re-check still decides.
 */
export async function assertTargetUserVisibleUnlocked(
  tx: Tx,
  opts: { targetId: EntityID; actorUserId: EntityID; scope: AccessScope | null }
): Promise<void> {
  const [target] = await tx
    .select({
      roleId: users.roleId,
      createdBy: users.createdBy,
      roleName: roles.roleName,
      roleScope: roles.scope,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(liveUser(eq(users.id, opts.targetId)))
    .limit(1);
  if (!target) throw notFoundError();
  assertTargetUserVisible({
    isSelf: opts.targetId === opts.actorUserId,
    roleId: target.roleId,
    createdBy: target.createdBy,
    role: { roleName: target.roleName, scope: target.roleScope },
    actorUserId: opts.actorUserId,
    scope: opts.scope,
  });
}

export async function assertTargetUserReachable(
  executor: Executor,
  opts: TargetUserVisibility & { actorPermissions: ActorPermissions }
): Promise<EntityID> {
  const roleId = assertTargetUserVisible(opts);
  await validateRolePermissionScope(
    opts.actorPermissions,
    roleId,
    executor,
    'reachability'
  );
  return roleId;
}

/** Non-throwing `validateRolePermissionScope`, for data omitted rather than refused. */
export async function actorCoversTargetRole(
  actorPermissions: ActorPermissions,
  roleId: EntityID,
  executor: Executor
): Promise<boolean> {
  try {
    await validateRolePermissionScope(
      actorPermissions,
      roleId,
      executor,
      'reachability'
    );
    return true;
  } catch (error) {
    // Both refusal shapes (404 and 403), or an omission becomes a whole-request refusal.
    if (
      error instanceof CustomError &&
      (error.status === HTTP_STATUS.FORBIDDEN ||
        error.status === HTTP_STATUS.NOT_FOUND)
    )
      return false;
    throw error;
  }
}
