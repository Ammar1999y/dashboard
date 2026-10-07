import type { Executor, Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { AccessScope } from '@app/shared/permissions/constants';
import type { PagePermissions } from '@app/shared/permissions/matrix';
import type { EntityID } from '@app/shared/types';

import { and, eq, ne, notInArray, sql } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_CREATE_ERROR } from '@app/shared/messages/common';
import {
  CUSTOM_ROLE_VALUE,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';
import { CUSTOM_ROLE_NAME_PREFIX } from '@app/shared/permissions/roles';

import { auditLog } from '@/lib/audit';
import { notFoundError } from '@/lib/http/response';
import { generateUuidV7 } from '@/lib/id';

import { PERMISSION_AUDIT_VERSION } from './audit';

export type RolePolicyTarget =
  { roleName?: string | null; scope?: string | null } | null | undefined;

/**
 * `FOR SHARE` is only worth taking inside a transaction. On the autocommit `db`
 * handle PostgreSQL releases the lock at statement end, so it pins nothing
 * across the caller's subsequent write and still writes a tuple lock to every
 * row it touches — pure cost on the read-only paths.
 *
 * Derived from the executor rather than a caller flag so a call site cannot ask
 * for a lock it is structurally unable to hold.
 */
export const holdsLocks = (executor: Executor): boolean => executor !== db;

/** System-scope roles are the developer's, never editable from the dashboard. */
export function nonSystemRoleFilter() {
  return ne(roles.scope, ROLE_SCOPE.SYSTEM);
}

export function isProtectedSystemRole(role: RolePolicyTarget): boolean {
  return role?.scope === ROLE_SCOPE.SYSTEM;
}

export function standardScopeFilter() {
  return eq(roles.scope, ROLE_SCOPE.STANDARD);
}

export function standardRoleFilter(roleId: EntityID) {
  return and(eq(roles.id, roleId), standardScopeFilter());
}

/**
 * Per-row UPSERT against `ux_role_permissions_role_page`: unchanged pages keep
 * their row and its `created_at`, changed pages are rewritten in place. `prune`
 * then drops the pages the matrix no longer lists, so the stored set matches it
 * exactly.
 */
export async function writeRoleMatrix(
  tx: Tx,
  roleId: EntityID,
  pages: PagePermissions,
  { prune }: { prune: boolean }
): Promise<void> {
  const rows = pages.map((p) => ({
    roleId,
    pageName: p.name,
    permissions: p.permissions,
  }));

  await tx
    .insert(rolePermissions)
    .values(rows)
    .onConflictDoUpdate({
      target: [rolePermissions.roleId, rolePermissions.pageName],
      set: { permissions: sql`excluded.permissions` },
    });

  if (prune)
    await tx.delete(rolePermissions).where(
      and(
        eq(rolePermissions.roleId, roleId),
        notInArray(
          rolePermissions.pageName,
          rows.map((r) => r.pageName)
        )
      )
    );
}

/**
 * With `existingRoleId`, rewrites that role's matrix and leaves its
 * `createdBy` untouched; otherwise mints a `custom` role stamped with
 * `createdBy`.
 */
export async function createCustomRole(
  tx: Tx,
  permissions: PagePermissions,
  existingRoleId?: EntityID | null,
  createdBy?: EntityID
): Promise<EntityID> {
  let roleId: EntityID;

  if (existingRoleId) {
    roleId = existingRoleId;
    // Lock the role row so concurrent writers serialize.
    //
    // Upsert + prune, not DELETE + INSERT: it preserves row identity and
    // `created_at`, writes only what changed, and keeps the audit diff
    // meaningful. Not for visibility — under MVCC no other transaction can see
    // this one's intermediate state either way.
    await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, roleId))
      .for('update');
  } else {
    const [customRole] = await tx
      .insert(roles)
      .values({
        roleName: `${CUSTOM_ROLE_NAME_PREFIX}${generateUuidV7()}`,
        scope: CUSTOM_ROLE_VALUE,
        isActive: true,
        createdBy: createdBy ?? null,
      })
      .returning({ id: roles.id });

    if (!customRole)
      throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

    roleId = customRole.id;
  }

  await writeRoleMatrix(tx, roleId, permissions, { prune: !!existingRoleId });

  return roleId;
}

/**
 * Deletes a custom role, its matrix recorded first: the user event names only
 * the role id, so without this row nothing says what the role granted.
 */
export async function destroyCustomRole(
  tx: Tx,
  params: {
    actorUserId: EntityID;
    actorEmail: string;
    roleId: EntityID;
    /** Ties the destroyed role back to the user it existed for. */
    forUserId: EntityID;
    meta: AuditMeta;
  }
): Promise<void> {
  const permissions = await tx
    .select({
      pageName: rolePermissions.pageName,
      permissions: rolePermissions.permissions,
    })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, params.roleId));

  await tx.delete(roles).where(eq(roles.id, params.roleId));

  await auditLog(tx, {
    userId: params.actorUserId,
    userEmail: params.actorEmail,
    action: 'DELETE',
    tableName: 'roles',
    recordId: params.roleId,
    oldData: {
      auditVersion: PERMISSION_AUDIT_VERSION,
      scope: CUSTOM_ROLE_VALUE,
      forUserId: params.forUserId,
      permissions,
    },
    meta: params.meta,
  });
}

/** An active standard role, or 404. */
export async function validateAssignableRole(
  roleId: EntityID,
  executor: Executor
): Promise<void> {
  // Under a `tx`, FOR SHARE prevents role deactivation/deletion between
  // validation and assignment; on `db` this is an advisory preflight only and
  // the caller must repeat it under its own transaction.
  const query = executor
    .select({ id: roles.id })
    .from(roles)
    .where(and(standardRoleFilter(roleId), eq(roles.isActive, true)));
  const [role] = await (holdsLocks(executor) ? query.for('share') : query);
  if (!role) throw notFoundError();
}

function ownedStandardRoleQuery(executor: Executor, roleId: EntityID) {
  return executor
    .select({
      id: roles.id,
      roleName: roles.roleName,
      description: roles.description,
      isActive: roles.isActive,
      createdBy: roles.createdBy,
    })
    .from(roles)
    .where(standardRoleFilter(roleId));
}

function assertReaches(
  role: { createdBy: EntityID | null } | undefined,
  scope: AccessScope | null,
  actorUserId: EntityID
): asserts role {
  if (!role) throw notFoundError();
  if (scope === 'own' && role.createdBy !== actorUserId) throw notFoundError();
}

/** The standard role `roleId` names, `FOR UPDATE`, or 404 when `scope` does not reach it. */
export async function lockOwnedStandardRole(
  tx: Tx,
  roleId: EntityID,
  scope: AccessScope | null,
  actorUserId: EntityID
) {
  const [role] = await ownedStandardRoleQuery(tx, roleId).for('update');
  assertReaches(role, scope, actorUserId);
  return role;
}

/**
 * `lockOwnedStandardRole`'s 404, without the lock: for a caller that must lock
 * rows ordered BEFORE the role, and so first proves it may touch them.
 */
export async function assertOwnedStandardRole(
  executor: Executor,
  roleId: EntityID,
  scope: AccessScope | null,
  actorUserId: EntityID
): Promise<void> {
  const [role] = await ownedStandardRoleQuery(executor, roleId);
  assertReaches(role, scope, actorUserId);
}

interface RoleRow {
  id: EntityID;
  roleName: string;
  scope: string;
}

interface PublicRoleFields {
  roleId: EntityID | typeof CUSTOM_ROLE_VALUE;
  role: { id: EntityID; roleName: string };
}

/** A user's role as the API publishes it: a custom role's id is masked. */
export function publicRoleFields(
  roleId: EntityID,
  role: RoleRow
): PublicRoleFields;
export function publicRoleFields(
  roleId: EntityID | null,
  role: RoleRow | null | undefined
): { [K in keyof PublicRoleFields]: PublicRoleFields[K] | null };
export function publicRoleFields(
  roleId: EntityID | null,
  role: RoleRow | null | undefined
) {
  return {
    roleId: role?.scope === CUSTOM_ROLE_VALUE ? CUSTOM_ROLE_VALUE : roleId,
    role: role ? { id: role.id, roleName: role.roleName } : null,
  };
}
