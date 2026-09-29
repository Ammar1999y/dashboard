import type { AuditMeta } from '@/lib/audit';
import type { ActorPermissions } from '@/lib/permissions/checker';
import type { AccessScope } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';

import { eq, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { accounts, userPreferences, users } from '@/db/schema';

import { PHONE_REQUIRED } from '@app/shared/config';
import {
  CUSTOM_ROLE_VALUE,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';
import { EMAIL_MAX } from '@app/shared/validation/constants';

import { auditLog } from '@/lib/audit';
import {
  revokeOtherSessions,
  revokePendingProofs,
  unlinkGoogle,
} from '@/lib/auth/session/rotation';
import { notFoundError } from '@/lib/http/response';
import { destroyCustomRole } from '@/lib/permissions/roles';

import { assertTargetUserReachable } from './target-user';

// `gen_random_uuid()::text` is always 36 characters; the anonymised email keeps
// within EMAIL_MAX by truncating ahead of the marker and the uuid.
const DELETED_EMAIL_SUFFIX = '_del_';
const UUID_TEXT_LENGTH = 36;
const DELETED_SUFFIX_LEN = DELETED_EMAIL_SUFFIX.length + UUID_TEXT_LENGTH;

/**
 * Soft-deletes a user: contacts anonymised, credentials and sessions gone, and
 * a custom role destroyed with its matrix recorded first. The most total
 * rotation there is, through the same helpers as every other.
 */
export async function softDeleteUser(opts: {
  targetId: EntityID;
  actor: { userId: EntityID; email: string };
  deleteScope: AccessScope | null;
  actorPermissions: ActorPermissions;
  auditMeta: AuditMeta;
}): Promise<void> {
  const {
    targetId: userId,
    actor,
    deleteScope,
    actorPermissions,
    auditMeta,
  } = opts;

  await withTransaction(async (tx) => {
    // User and role locked together, so another transaction cannot flip the
    // role's scope or name between the reads.
    // TODO: test whether `FOR UPDATE OF u FOR SHARE OF r` locks as expected.
    const locked = await tx.execute<{
      email: string;
      phone_number: string | null;
      role_id: EntityID;
      role_name: string;
      role_scope: string;
      created_by: EntityID | null;
    }>(sql`
        SELECT u.email, u.phone_number, u.role_id, u.created_by, r.role_name, r.scope AS role_scope
        FROM users u
        INNER JOIN roles r ON r.id = u.role_id
        WHERE u.id = ${userId}
          AND u.deleted_at IS NULL
          AND r.scope <> ${ROLE_SCOPE.SYSTEM}
        FOR UPDATE OF u
        FOR SHARE OF r
      `);

    const lockedUser = locked[0];
    if (!lockedUser) throw notFoundError();

    await assertTargetUserReachable(tx, {
      isSelf: false,
      roleId: lockedUser.role_id,
      createdBy: lockedUser.created_by,
      role: { roleName: lockedUser.role_name, scope: lockedUser.role_scope },
      actorUserId: actor.userId,
      scope: deleteScope,
      actorPermissions,
    });

    await tx
      .update(users)
      .set({
        email: sql`LEFT(email, ${EMAIL_MAX - DELETED_SUFFIX_LEN}) || ${DELETED_EMAIL_SUFFIX} || gen_random_uuid()`,
        // In 'required' mode the column is NOT NULL, so the number becomes a
        // format-valid dummy; the partial unique index skips soft-deleted rows.
        phoneNumber: PHONE_REQUIRED
          ? sql`'9665' || LPAD((FLOOR(RANDOM() * 100000000))::bigint::text, 8, '0')`
          : null,
        // The anonymised email is no proven address, and a cleared phone would
        // violate `chk_phone_verified_requires_phone`.
        emailVerified: false,
        phoneNumberVerified: false,
        deletedAt: sql`now()`,
        updatedAt: sql`now()`,
        isActive: false,
        roleId: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, userId));

    await revokeOtherSessions(tx, userId);
    await revokePendingProofs(tx, userId);
    await unlinkGoogle(tx, userId, auditMeta);
    await tx.delete(accounts).where(eq(accounts.userId, userId));
    // Explicit, because the FK cascade never fires: this row is soft-deleted
    // and never purged.
    await tx.delete(userPreferences).where(eq(userPreferences.userId, userId));
    if (lockedUser.role_scope === CUSTOM_ROLE_VALUE)
      await destroyCustomRole(tx, {
        actorUserId: actor.userId,
        actorEmail: actor.email,
        roleId: lockedUser.role_id,
        forUserId: userId,
        meta: auditMeta,
      });

    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.email,
      action: 'DELETE',
      tableName: 'users',
      recordId: userId,
      oldData: {
        email: lockedUser.email,
        phoneNumber: lockedUser.phone_number,
        roleId: lockedUser.role_id,
        roleName: lockedUser.role_name,
        roleScope: lockedUser.role_scope,
      },
      meta: auditMeta,
    });
  });
}
