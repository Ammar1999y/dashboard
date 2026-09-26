import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { checkUserPermission } from '@/lib/permissions/checker';
import type { PermissionRows } from '@/lib/permissions/utils';
import type { EntityID } from '@app/shared/types';
import type { adminUpdateUserBodySchema } from '@app/shared/validation/auth';
import type { z } from 'zod';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { accounts, rolePermissions, roles, users } from '@/db/schema';

import { HTTP_STATUS, MSG_NOT_FOUND } from '@app/shared/api-messages';
import { PHONE_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';

import { auditLog } from '@/lib/audit';
import { CREDENTIAL_PROVIDER_ID } from '@/lib/auth/credential';
import { twoFactorMsg } from '@/lib/auth/messages';
import { checkPasswordCompromise } from '@/lib/auth/password/compromise';
import { hashPassword } from '@/lib/auth/password/hash';
import { requireReauthWindow } from '@/lib/auth/reauth/window';
import {
  revokeOtherSessions,
  revokePendingProofs,
  unlinkGoogle,
} from '@/lib/auth/session/rotation';
import {
  contactChangeStrandsTwoFactor,
  removeMethodIntent,
} from '@/lib/auth/two-factor/methods';
import { insufficientPermissions } from '@/lib/permissions/checker';
import {
  auditCustomRolePermissions,
  createCustomRole,
  isProtectedSystemRole,
  PERMISSION_AUDIT_VERSION,
  permissionsEqual,
  refreshUserSessions,
  validateAssignableRole,
  validatePermissionScope,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';

import { userMsg } from './messages';

type ActorPermissions = Awaited<
  ReturnType<typeof checkUserPermission>
>['permissions'];

interface EditActor {
  userId: EntityID;
  sessionId: EntityID | null;
  userEmail: string;
}

/**
 * A user renaming themselves, in one round trip: the CTE hands the UPDATE the
 * pre-update name for the audit row. No `FOR UPDATE` — a user cannot usefully
 * race themselves, and the WHERE refuses a concurrently deactivated or deleted
 * row.
 */
export async function renameSelf(
  actor: { userId: EntityID; userEmail: string },
  name: string,
  auditMeta: AuditMeta
): Promise<{ updatedAt: Date }> {
  const targetId = actor.userId;
  return withTransaction(async (tx) => {
    const updated = await tx.execute<{
      old_name: string;
      updated_at: Date;
    }>(sql`
      WITH prev AS (
        SELECT id, name FROM users WHERE id = ${targetId}
      )
      UPDATE users u
      SET name = ${name}, updated_at = now()
      FROM prev
      WHERE u.id = prev.id
        AND u.deleted_at IS NULL
        AND u.is_active = true
      RETURNING prev.name AS old_name, u.updated_at AS updated_at
    `);

    const row = updated[0];
    if (!row) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: 'UPDATE',
      tableName: 'users',
      recordId: targetId,
      oldData: { name: row.old_name },
      newData: { name },
      meta: auditMeta,
    });

    return { updatedAt: row.updated_at };
  });
}

/**
 * Every unreachable-target gate, read WITHOUT a lock, answering the same 404
 * the locked gates answer. A deliberate copy: it exists to refuse before the
 * HIBP request and the Argon2 hash, and a row lock taken to decide whether to
 * do that work would defeat it. Role AUTHORITY is one of the gates — without
 * it an actor with broad edit scope still paid for both against a target that
 * outranks them.
 */
async function assertTargetEditable(opts: {
  targetId: EntityID;
  actorUserId: EntityID;
  editScope: 'all' | 'own';
  actorPermissions: ActorPermissions;
}): Promise<void> {
  const [target] = await db
    .select({
      createdBy: users.createdBy,
      roleId: users.roleId,
      roleName: roles.roleName,
      roleScope: roles.scope,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, opts.targetId), isNull(users.deletedAt)))
    .limit(1);

  const unreachable =
    !target ||
    isProtectedSystemRole({
      roleName: target.roleName,
      scope: target.roleScope,
    }) ||
    (opts.editScope === 'own' && target.createdBy !== opts.actorUserId);

  if (unreachable) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  if (opts.actorPermissions && target.roleId)
    await validateRolePermissionScope(
      opts.actorPermissions,
      target.roleId,
      db,
      'reachability'
    );
}

/**
 * The `D12` window for an actor whose session id came from the permission
 * read. A `null` id cannot own a window, so it is refused rather than skipped.
 */
async function requireAdminReauth(
  actor: EditActor,
  executor?: Tx
): Promise<void> {
  await requireReauthWindow(actor.userId, actor.sessionId ?? '', executor);
}

/**
 * An administrator's edit of another user. The contract is a total object —
 * a rename restates the current email, role and active flag — so every
 * authority and re-authentication decision is taken on the actual change,
 * against the row locked below.
 */
export async function editUserAsAdmin(opts: {
  actor: EditActor;
  actorPermissions: ActorPermissions;
  editScope: 'all' | 'own';
  targetId: EntityID;
  input: z.output<typeof adminUpdateUserBodySchema>;
  auditMeta: AuditMeta;
}): Promise<{ updatedAt: Date }> {
  const { actor, actorPermissions, editScope, targetId, input, auditMeta } =
    opts;
  const isCustomRole = input.roleId === CUSTOM_ROLE_VALUE;

  const password = input.password;
  if (password) {
    // Before the HIBP request and the Argon2 hash: a supplied password is the
    // one `D12` change knowable from the request alone.
    await requireAdminReauth(actor);
    // ADDITIVE, never authoritative: the locked transaction re-runs every gate
    // and decides; this can only refuse earlier, and only when there is
    // expensive work to refuse.
    await assertTargetEditable({
      targetId,
      actorUserId: actor.userId,
      editScope,
      actorPermissions,
    });
    await checkPasswordCompromise(password);
  }
  const hashedPassword = password ? await hashPassword(password) : null;

  return withTransaction(async (tx) => {
    const [lockedUser] = await tx
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        phoneNumber: users.phoneNumber,
        phoneNumberVerified: users.phoneNumberVerified,
        roleId: users.roleId,
        isActive: users.isActive,
        createdBy: users.createdBy,
        roleName: roles.roleName,
        roleScope: roles.scope,
        roleCreatedBy: roles.createdBy,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
      .for('update', { of: users });

    if (!lockedUser?.roleId)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (
      isProtectedSystemRole({
        roleName: lockedUser.roleName,
        scope: lockedUser.roleScope,
      })
    )
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (editScope === 'own' && lockedUser.createdBy !== actor.userId)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const isCurrentlyCustom = lockedUser.roleScope === CUSTOM_ROLE_VALUE;

    if (!isCustomRole) await validateAssignableRole(input.roleId, tx);

    if (actorPermissions) {
      // Reachability on the target's CURRENT role: a 403 here would tell
      // "this account exists and outranks me" apart from the neighbouring 404s.
      await validateRolePermissionScope(
        actorPermissions,
        lockedUser.roleId,
        tx,
        'reachability'
      );

      if (isCustomRole && input.permissions?.length) {
        validatePermissionScope(actorPermissions, input.permissions);
      } else if (!isCustomRole && input.roleId !== lockedUser.roleId) {
        // Grant on the role being ASSIGNED: the caller named it, so its
        // existence is no secret and 403 is the useful answer.
        await validateRolePermissionScope(
          actorPermissions,
          input.roleId,
          tx,
          'grant'
        );
      }
    }

    // Diffed BEFORE the authority gate below, which depends on it: a supplied
    // matrix is a permission mutation only if it differs from the stored one,
    // so renaming a custom-role user needs no `permissions.edit`.
    const suppliedMatrix = input.permissions?.length ? input.permissions : null;
    const newPermsForAudit: PermissionRows | null =
      isCustomRole && suppliedMatrix
        ? suppliedMatrix.map((p) => ({
            pageName: p.name,
            permissions: p.permissions,
          }))
        : null;

    let oldPermsForAudit: PermissionRows | null = null;
    let customPermsChanged = false;

    if (newPermsForAudit && isCurrentlyCustom) {
      const oldPerms = await tx
        .select({
          pageName: rolePermissions.pageName,
          permissions: rolePermissions.permissions,
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, lockedUser.roleId));

      oldPermsForAudit = oldPerms.map((p) => ({
        pageName: p.pageName,
        permissions: p.permissions,
      }));

      customPermsChanged = !permissionsEqual(
        oldPermsForAudit,
        newPermsForAudit
      );
    }

    if (isCustomRole) {
      if (!isCurrentlyCustom) {
        // Switching TO custom mints a role.
        if (actorPermissions?.['permissions']?.['create'] !== true)
          throw insufficientPermissions();
      } else if (customPermsChanged) {
        const hasEditAll = actorPermissions?.['permissions']?.['edit'] === true;
        const hasEditOwn =
          actorPermissions?.['permissions']?.['editOwn'] === true &&
          lockedUser.roleCreatedBy === actor.userId;
        if (!hasEditAll && !hasEditOwn) throw insufficientPermissions();
      }
    }

    let assignedRoleId: EntityID;
    // Deferred so the matrix audit row follows the user UPDATE.
    let customRoleAudit: (() => Promise<void>) | null = null;

    if (newPermsForAudit && suppliedMatrix) {
      if (isCurrentlyCustom) {
        // An unchanged matrix is not rewritten, which would reset `created_at`.
        assignedRoleId = customPermsChanged
          ? await createCustomRole(tx, suppliedMatrix, lockedUser.roleId)
          : lockedUser.roleId;

        // An in-place custom edit keeps the role id, so the user audit row
        // shows no change; the matrix is recorded on its own.
        if (customPermsChanged) {
          const roleIdForAudit = assignedRoleId;
          const oldPermissions = oldPermsForAudit ?? [];
          customRoleAudit = () =>
            auditCustomRolePermissions(tx, {
              actorUserId: actor.userId,
              actorEmail: actor.userEmail,
              roleId: roleIdForAudit,
              oldPermissions,
              newPermissions: newPermsForAudit,
              targetUserId: targetId,
              meta: auditMeta,
            });
        }
      } else {
        assignedRoleId = await createCustomRole(
          tx,
          suppliedMatrix,
          null,
          actor.userId
        );

        const roleIdForAudit = assignedRoleId;
        customRoleAudit = () =>
          auditCustomRolePermissions(tx, {
            actorUserId: actor.userId,
            actorEmail: actor.userEmail,
            roleId: roleIdForAudit,
            newPermissions: newPermsForAudit,
            targetUserId: targetId,
            meta: auditMeta,
          });
      }
    } else if (isCustomRole) {
      // No matrix means "keep the current one" — the client sends it only when
      // it changed. Switching TO custom has nothing to keep.
      if (!isCurrentlyCustom)
        throw new CustomError(
          userMsg.customRoleNeedsPermissions,
          HTTP_STATUS.UNPROCESSABLE
        );
      assignedRoleId = lockedUser.roleId;
    } else {
      assignedRoleId = input.roleId;
    }

    const emailChanged = lockedUser.email !== input.email;
    // An omitted key keeps the number; only an explicit null/'' clears it.
    // Presence comes from the PARSED value, so a stripped typo cannot read as
    // "not supplied".
    const phoneProvided = input.phoneNumber !== undefined;
    const newPhoneNumber = input.phoneNumber ?? null;
    const phoneChanged =
      PHONE_ENABLED &&
      phoneProvided &&
      lockedUser.phoneNumber !== newPhoneNumber;

    // `D12` is the CHANGE, not the grant, decided from the LOCKED row: a window
    // skipped on a stale comparison is a security decision made against a row
    // somebody else has since changed. Nothing is written yet, so an unproven
    // session costs a rollback.
    const roleChanged = lockedUser.roleId !== assignedRoleId;
    if (
      emailChanged ||
      phoneChanged ||
      roleChanged ||
      customPermsChanged ||
      lockedUser.isActive !== input.isActive
    )
      await requireAdminReauth(actor, tx);

    if (emailChanged) await unlinkGoogle(tx, targetId, auditMeta);

    // A contact change takes the OTP factor bound to it out of the offered set.
    // When that is the target's last usable factor the edit is refused and the
    // operator is pointed at `resetTwoFactor`, the permission that exists for
    // disarming 2FA. One question over BOTH changed kinds.
    const changedContactKinds = [
      ...(emailChanged ? (['email'] as const) : []),
      ...(phoneChanged ? (['phone'] as const) : []),
    ];
    if (await contactChangeStrandsTwoFactor(targetId, changedContactKinds, tx))
      throw new CustomError(
        twoFactorMsg.contactChangeStrands,
        HTTP_STATUS.CONFLICT
      );

    const [userUpdated] = await tx
      .update(users)
      .set({
        name: input.name,
        email: input.email,
        isActive: input.isActive,
        roleId: assignedRoleId,
        // An admin-set address is unproven: the flag resets until the owner
        // re-proves it by OTP.
        ...(emailChanged && { emailVerified: false }),
        ...(phoneChanged && {
          phoneNumber: newPhoneNumber,
          phoneNumberVerified: false,
        }),
        // The admin reset is the recovery path for a locked-out user, so the
        // brute-force counters clear with the password.
        ...(password && { failedLoginAttempts: 0, lockedUntil: null }),
      })
      .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
      .returning({ id: users.id, updatedAt: users.updatedAt });

    if (!userUpdated)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    // ⚠️ The OTP enrolment does NOT follow a contact to its new address, and
    // `two_factor_enabled` is left alone: clearing it would make `users.edit` a
    // 2FA disarm. The refusal above keeps this from stranding anyone.
    for (const kind of changedContactKinds)
      await removeMethodIntent(tx, targetId, 'otp', kind);

    if (isCurrentlyCustom && lockedUser.roleId !== assignedRoleId) {
      const oldCustomPerms = await tx
        .select({
          pageName: rolePermissions.pageName,
          permissions: rolePermissions.permissions,
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, lockedUser.roleId));

      await tx.delete(roles).where(eq(roles.id, lockedUser.roleId));

      await auditLog(tx, {
        userId: actor.userId,
        userEmail: actor.userEmail,
        action: 'DELETE',
        tableName: 'roles',
        recordId: lockedUser.roleId,
        oldData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          scope: CUSTOM_ROLE_VALUE,
          // Ties the destroyed role back to the user it existed for.
          forUserId: targetId,
          permissions: oldCustomPerms,
        },
        metadataFields: ['auditVersion', 'scope', 'forUserId'],
        meta: auditMeta,
      });
    }

    // Any credential or identity change ends existing sessions. Phone counts:
    // it is a passwordless login factor, as in the self-service flow.
    const shouldDeleteAllSessions =
      !!password ||
      emailChanged ||
      phoneChanged ||
      (lockedUser.isActive && input.isActive === false);
    const shouldRefreshSessions =
      !shouldDeleteAllSessions && (roleChanged || customPermsChanged);

    if (password) {
      const [updated] = await tx
        .update(accounts)
        .set({
          password: hashedPassword,
        })
        .where(
          and(
            eq(accounts.userId, targetId),
            eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
          )
        )
        .returning({ id: accounts.id });

      if (!updated?.id)
        throw new CustomError(
          userMsg.ssoCannotModifyPassword,
          HTTP_STATUS.BAD_REQUEST
        );
    }

    // Sequential: the statements share the transaction's one connection, and an
    // explicit order decides which failure surfaces.
    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: 'UPDATE',
      tableName: 'users',
      recordId: targetId,
      // Both sides of every mutated field, so the change is reconstructable
      // from this event alone.
      oldData: {
        name: lockedUser.name,
        email: lockedUser.email,
        roleId: lockedUser.roleId,
        isActive: lockedUser.isActive,
        ...(emailChanged && { emailVerified: lockedUser.emailVerified }),
        ...(phoneChanged && {
          phoneNumber: lockedUser.phoneNumber,
          phoneNumberVerified: lockedUser.phoneNumberVerified,
        }),
      },
      newData: {
        name: input.name,
        email: input.email,
        roleId: assignedRoleId,
        isActive: input.isActive,
        ...(emailChanged && { emailVerified: false }),
        ...(phoneChanged && {
          phoneNumber: newPhoneNumber,
          phoneNumberVerified: false,
        }),
        ...(password && { passwordChanged: true }),
      },
      // A matrix-only edit changes nothing on the user row; the roles event is
      // the change, and an empty users UPDATE beside it would read as a
      // genuine no-change write.
      skipIfUnchanged: true,
      meta: auditMeta,
    });

    if (customRoleAudit) await customRoleAudit();

    // No session kept: the actor is an admin, not the target.
    if (shouldDeleteAllSessions) await revokeOtherSessions(tx, targetId);
    else if (shouldRefreshSessions) await refreshUserSessions(targetId, tx);

    // A stale change_* proof must not commit over the admin's change.
    if (emailChanged || phoneChanged || shouldDeleteAllSessions)
      await revokePendingProofs(tx, targetId);

    return { updatedAt: userUpdated.updatedAt };
  });
}
