import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { PermissionRows } from '@app/shared/permissions/matrix';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';
import type { adminUpdateUserBodySchema } from '@app/shared/validation/auth';

import { eq, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { accounts, rolePermissions, roles, users } from '@/db/schema';
import * as z from 'zod';

import { PHONE_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { userMsg } from '@app/shared/messages/users';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import {
  permissionsEqual,
  toPermissionRows,
} from '@app/shared/permissions/matrix';
import {
  holdsActionOn,
  resolveActionScope,
  validatePermissionScope,
} from '@app/shared/permissions/scope';

import { auditLog } from '@/lib/audit';
import { credentialAccountOf } from '@/lib/auth/credential-account';
import { checkPasswordCompromise } from '@/lib/auth/password/compromise';
import { hashPassword } from '@/lib/auth/password/hash';
import { requireReauthWindow } from '@/lib/auth/reauth/window';
import {
  revokeOtherSessions,
  revokePendingProofs,
  unlinkGoogle,
} from '@/lib/auth/session/rotation';
import { removeMethodIntent } from '@/lib/auth/two-factor/methods';
import { lockTargetAndActor } from '@/lib/auth/user-eligibility';
import { notFoundError } from '@/lib/http/response';
import { auditCustomRolePermissions } from '@/lib/permissions/audit';
import { insufficientPermissions } from '@/lib/permissions/checker';
import {
  createCustomRole,
  destroyCustomRole,
  validateAssignableRole,
} from '@/lib/permissions/roles';
import { validateRolePermissionScope } from '@/lib/permissions/scope';
import { refreshUserSessions } from '@/lib/permissions/session-refresh';

import { assertContactChangeKeepsFactor } from './contact-change';
import { liveUser } from './filters';
import {
  assertTargetUserReachable,
  assertTargetUserVisible,
  assertTargetUserVisibleUnlocked,
} from './target-user';

interface EditActor {
  userId: EntityID;
  sessionId: EntityID;
  userEmail: string;
}

/** `renameSelf`'s raw row, checked: `execute<T>` would only assert it. */
const renamedRowSchema = z.object({
  old_name: z.string(),
  updated_at: z.date(),
});

// No `FOR UPDATE`: a user cannot usefully race themselves, and the WHERE refuses
// a concurrently deactivated or deleted row.
export async function renameSelf(
  actor: { userId: EntityID; userEmail: string },
  name: string,
  auditMeta: AuditMeta
): Promise<{ updatedAt: Date }> {
  const targetId = actor.userId;
  return withTransaction(async (tx) => {
    const updated = await tx.execute(sql`
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

    const [returned] = updated;
    if (!returned) throw notFoundError();
    const row = renamedRowSchema.parse(returned);

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
 * A deliberate unlocked copy of the locked gates, answering the same 404, so the
 * HIBP request and Argon2 hash can be refused early. Not authoritative.
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
    .where(liveUser(eq(users.id, opts.targetId)))
    .limit(1);

  if (!target) throw notFoundError();

  await assertTargetUserReachable(db, {
    isSelf: false,
    roleId: target.roleId,
    createdBy: target.createdBy,
    role: { roleName: target.roleName, scope: target.roleScope },
    actorUserId: opts.actorUserId,
    scope: opts.editScope,
    actorPermissions: opts.actorPermissions,
  });
}

async function requireAdminReauth(
  actor: EditActor,
  executor?: Tx
): Promise<void> {
  await requireReauthWindow(actor.userId, actor.sessionId, executor);
}

// The body is total (a rename restates everything), so every decision is taken
// on the actual change against the locked row.
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
    // Before the HIBP request and hash: the one change lowering another
    // account's security posture knowable from the request alone.
    await requireAdminReauth(actor);
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
    await assertTargetUserVisibleUnlocked(tx, {
      targetId,
      actorUserId: actor.userId,
      scope: editScope,
    });
    await lockTargetAndActor(tx, targetId, actor.userId, 'update');
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
      .where(liveUser(eq(users.id, targetId)))
      .for('update', { of: users });

    if (!lockedUser?.roleId) throw notFoundError();

    // Not `assertTargetUserReachable`: that would take the `role_permissions`
    // share lock ahead of `validateAssignableRole`'s role lock.
    assertTargetUserVisible({
      isSelf: false,
      roleId: lockedUser.roleId,
      createdBy: lockedUser.createdBy,
      role: { roleName: lockedUser.roleName, scope: lockedUser.roleScope },
      actorUserId: actor.userId,
      scope: editScope,
    });

    const isCurrentlyCustom = lockedUser.roleScope === CUSTOM_ROLE_VALUE;

    const assignsStandardRole =
      !isCustomRole && input.roleId !== lockedUser.roleId;

    // Only on a change: a deactivated role keeps its members, and an edit that
    // restates it must still reach them. A custom role is restated as
    // `'custom'`, never by its id, which is no standard role.
    if (assignsStandardRole || (!isCustomRole && isCurrentlyCustom))
      await validateAssignableRole(input.roleId, tx);

    // A 403 here would reveal "exists and outranks me" beside the 404s.
    await validateRolePermissionScope(
      actorPermissions,
      lockedUser.roleId,
      tx,
      'reachability'
    );

    if (isCustomRole && input.permissions?.length) {
      validatePermissionScope(actorPermissions, input.permissions);
    } else if (assignsStandardRole) {
      // The caller named this role, so 403 reveals nothing.
      await validateRolePermissionScope(
        actorPermissions,
        input.roleId,
        tx,
        'grant'
      );
    }

    // Diffed before the authority gate: renaming a custom-role user restates
    // the matrix and must need no `permissions.edit`.
    const suppliedMatrix = input.permissions?.length ? input.permissions : null;
    const newPermsForAudit: PermissionRows | null =
      isCustomRole && suppliedMatrix ? toPermissionRows(suppliedMatrix) : null;

    let oldPermsForAudit: PermissionRows | null = null;
    let customPermsChanged = false;

    if (newPermsForAudit && isCurrentlyCustom) {
      oldPermsForAudit = await tx
        .select({
          pageName: rolePermissions.pageName,
          permissions: rolePermissions.permissions,
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, lockedUser.roleId));

      customPermsChanged = !permissionsEqual(
        oldPermsForAudit,
        newPermsForAudit
      );
    }

    if (isCustomRole) {
      if (!isCurrentlyCustom) {
        if (
          !resolveActionScope(actorPermissions, 'permissions', 'create').allowed
        )
          throw insufficientPermissions();
      } else if (
        customPermsChanged &&
        !holdsActionOn(
          actorPermissions,
          'permissions',
          'edit',
          lockedUser.roleCreatedBy,
          actor.userId
        )
      ) {
        throw insufficientPermissions();
      }
    }

    let assignedRoleId: EntityID;
    // Deferred so the matrix audit row follows the user UPDATE.
    let customRoleAudit: (() => Promise<void>) | null = null;

    if (newPermsForAudit && suppliedMatrix) {
      if (isCurrentlyCustom) {
        assignedRoleId = customPermsChanged
          ? await createCustomRole(tx, suppliedMatrix, lockedUser.roleId)
          : lockedUser.roleId;

        // The user audit row shows no change, so the matrix is recorded separately.
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
      // No matrix means "keep the current one".
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
    // Omitted keeps the number; only an explicit null/'' clears it.
    const phoneProvided = input.phoneNumber !== undefined;
    const newPhoneNumber = input.phoneNumber ?? null;
    const phoneChanged =
      PHONE_ENABLED &&
      phoneProvided &&
      lockedUser.phoneNumber !== newPhoneNumber;

    // Decided from the locked row, never a stale comparison. Nothing is written
    // yet, so an unproven session costs only a rollback.
    const roleChanged = lockedUser.roleId !== assignedRoleId;
    if (
      emailChanged ||
      phoneChanged ||
      roleChanged ||
      customPermsChanged ||
      lockedUser.isActive !== input.isActive
    )
      await requireAdminReauth(actor, tx);

    if (emailChanged)
      await unlinkGoogle(
        tx,
        targetId,
        { userId: actor.userId, email: actor.userEmail },
        auditMeta
      );

    // One question over both kinds; disarming 2FA is `resetTwoFactor`'s job.
    const changedContactKinds = [
      ...(emailChanged ? (['email'] as const) : []),
      ...(phoneChanged ? (['phone'] as const) : []),
    ];
    await assertContactChangeKeepsFactor(tx, targetId, changedContactKinds);

    const [userUpdated] = await tx
      .update(users)
      .set({
        name: input.name,
        email: input.email,
        isActive: input.isActive,
        roleId: assignedRoleId,
        // An admin-set address is unproven.
        ...(emailChanged && { emailVerified: false }),
        ...(phoneChanged && {
          phoneNumber: newPhoneNumber,
          phoneNumberVerified: false,
        }),
        // The admin reset is how a locked-out user recovers.
        ...(password && { failedLoginAttempts: 0, lockedUntil: null }),
      })
      .where(liveUser(eq(users.id, targetId)))
      .returning({ id: users.id, updatedAt: users.updatedAt });

    if (!userUpdated) throw notFoundError();

    // ⚠️ `two_factor_enabled` is left alone: clearing it would make `users.edit`
    // a 2FA disarm.
    for (const kind of changedContactKinds)
      await removeMethodIntent(tx, targetId, 'otp', kind);

    if (isCurrentlyCustom && lockedUser.roleId !== assignedRoleId)
      await destroyCustomRole(tx, {
        actorUserId: actor.userId,
        actorEmail: actor.userEmail,
        roleId: lockedUser.roleId,
        forUserId: targetId,
        meta: auditMeta,
      });

    // Phone counts: it is a passwordless factor.
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
        .where(credentialAccountOf(targetId))
        .returning({ id: accounts.id });

      if (!updated?.id)
        throw new CustomError(
          userMsg.ssoCannotModifyPassword,
          HTTP_STATUS.BAD_REQUEST
        );
    }

    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: 'UPDATE',
      tableName: 'users',
      recordId: targetId,
      // Both sides of every mutated field, a field added later included, so
      // the change is reconstructable from this event alone.
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
      // A matrix-only edit is recorded by the roles event alone.
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
