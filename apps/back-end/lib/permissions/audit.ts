import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { PermissionRows } from '@app/shared/permissions/matrix';
import type { EntityID } from '@app/shared/types';

import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { diffPermissionMatrices } from '@app/shared/permissions/matrix';

import { auditLog } from '@/lib/audit';

/**
 * Version marker on every role/permission audit payload.
 *
 * Consumers need to know which contract a stored row follows: matrices are
 * recorded as submitted (`{ pageName, permissions }`, listing only the pages
 * involved) with `changedPermissions` carrying the normalised
 * `page.action: before -> after` diff. Storing the full dashboard matrix on
 * every row instead would be mostly zeros and would push large grants past the
 * audit byte cap. Bump this if either side of that contract changes.
 */
export const PERMISSION_AUDIT_VERSION = 1;

/**
 * Keys in a role/permission audit payload that describe the event, not the
 * role. They must not appear in `changedFields`: `forUserId` and
 * `changedPermissions` exist only on the new side, so counting them would
 * report a changed field on every event.
 */
export const PERMISSION_AUDIT_METADATA_FIELDS = [
  'auditVersion',
  'scope',
  'forUserId',
  'changedPermissions',
] as const;

/**
 * Write the forensic record for a CUSTOM role's permission matrix.
 *
 * Custom roles are created/mutated as a side effect of a user create or
 * update. The user audit row carries no matrix, and an in-place custom edit
 * doesn't even change `role_id` — so without this event there is no way to
 * reconstruct who granted a sensitive permission. Format mirrors the
 * standard-role audit in the permissions endpoints so both role types share
 * one contract.
 */
export async function auditCustomRolePermissions(
  tx: Tx,
  params: {
    actorUserId: EntityID;
    actorEmail: string;
    roleId: EntityID;
    /** Absent for a freshly created custom role. */
    oldPermissions?: PermissionRows;
    newPermissions: PermissionRows;
    /** The user the custom role belongs to — the reason it exists. */
    targetUserId: EntityID;
    meta: AuditMeta;
  }
): Promise<void> {
  const isCreate = params.oldPermissions === undefined;
  const changedPermissions = diffPermissionMatrices(
    params.oldPermissions ?? [],
    params.newPermissions
  );

  await auditLog(tx, {
    userId: params.actorUserId,
    userEmail: params.actorEmail,
    action: isCreate ? 'INSERT' : 'UPDATE',
    tableName: 'roles',
    recordId: params.roleId,
    oldData: isCreate
      ? null
      : {
          auditVersion: PERMISSION_AUDIT_VERSION,
          scope: CUSTOM_ROLE_VALUE,
          permissions: params.oldPermissions,
        },
    newData: {
      auditVersion: PERMISSION_AUDIT_VERSION,
      scope: CUSTOM_ROLE_VALUE,
      forUserId: params.targetUserId,
      permissions: params.newPermissions,
      changedPermissions,
    },
    metadataFields: PERMISSION_AUDIT_METADATA_FIELDS,
    meta: params.meta,
  });
}
