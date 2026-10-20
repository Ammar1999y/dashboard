import type { VerifiedPasswordProof } from '@/lib/auth/login-guard';

import { and, eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { accounts, userPreferences, users } from '@/db/schema';

import {
  changePassword,
  getPreferences,
  updatePreferences,
  updateSelf,
} from '@app/shared/api/users';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_UPDATE_ERROR,
  MSG_UPDATED,
} from '@app/shared/messages/common';
import { userMsg } from '@app/shared/messages/users';
import { sanitizePreferences } from '@app/shared/validation/preferences';

import { auditLog, getAuditMeta } from '@/lib/audit';
import { CREDENTIAL_PROVIDER_ID } from '@/lib/auth/credential';
import { credentialAccountOf } from '@/lib/auth/credential-account';
import { verifyLoginAttempt } from '@/lib/auth/login-guard';
import { checkPasswordCompromise } from '@/lib/auth/password/compromise';
import { hashPassword, verifyPassword } from '@/lib/auth/password/hash';
import { requireReauthWindow } from '@/lib/auth/reauth/window';
import {
  revokeOtherSessions,
  revokePendingProofs,
} from '@/lib/auth/session/rotation';
import { bind } from '@/lib/http/binding';
import {
  insufficientPermissions,
  refreshSessionCookies,
} from '@/lib/permissions/checker';
import { asCurrentPasswordIncorrect } from '@/lib/users/current-password';
import { renameSelf } from '@/lib/users/edit';
import { liveUser } from '@/lib/users/filters';

export const updateSelfBinding = bind(updateSelf, {
  permission: { resource: 'users', action: 'edit', orSelf: true },
  rateLimit: { scope: 'users.me.put', limit: 10, failClosed: true, by: 'user' },
  failure: MSG_UPDATE_ERROR,
  detail: {
    summary: 'Rename the signed-in user',
    description:
      'Takes `name` alone; any other key is refused 422. Needs no grant, but a caller whose role is missing or inactive is refused 403. The only way to rename yourself: `PUT /api/dash/users/{id}` refuses the caller’s own id.',
    tags: ['Account'],
    setCookie: 'The session cookie cache is re-minted with the new name.',
  },
  handler: async ({ body, actor, meta }) => {
    const { updatedAt } = await renameSelf(
      { userId: actor.userId, userEmail: actor.session.user.email },
      body.name,
      getAuditMeta(meta)
    );
    return {
      message: MSG_UPDATED,
      data: { updatedAt: updatedAt.toISOString() },
      cookies: await refreshSessionCookies(meta.headers),
    };
  },
});

export const changePasswordBinding = bind(changePassword, {
  rateLimit: {
    scope: 'users.me.change-password.post',
    limit: 5,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_UPDATE_ERROR,
  detail: { summary: 'Change the current password', tags: ['Account'] },
  handler: async ({ body: input, actor, meta }) => {
    const { session, userId, sessionId } = actor;

    // The `currentPassword` branch only: that value is verified against the
    // stored hash below, so plaintext equality with it IS equality with the
    // stored password, at no Argon2 cost. The window branch has no plaintext and
    // is checked against the hash instead.
    if (input.currentPassword === input.newPassword)
      throw new CustomError(
        userMsg.newPasswordSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

    await checkPasswordCompromise(input.newPassword);

    const auditMeta = getAuditMeta(meta);

    // Argon2 stays outside the mutation transaction; the proof is consumed with
    // a compare-and-swap condition under the account row lock.
    let passwordProof: VerifiedPasswordProof;
    try {
      if (input.currentPassword === undefined) {
        await requireReauthWindow(userId, sessionId);
        const [credential] = await db
          .select({ accountId: accounts.id, expectedHash: accounts.password })
          .from(accounts)
          .where(credentialAccountOf(userId));
        if (!credential?.expectedHash)
          throw new CustomError(
            userMsg.passwordUpdateFailed,
            HTTP_STATUS.BAD_REQUEST
          );

        // The same-password rule against the only thing this branch has, the
        // stored hash; otherwise an open window lets a caller "change" to the
        // existing password, revoking every session and proof and auditing a
        // change that did not happen. One Argon2 verify, the cost of the other
        // branch.
        if (
          await verifyPassword({
            hash: credential.expectedHash,
            password: input.newPassword,
          })
        )
          throw new CustomError(
            userMsg.newPasswordSameAsCurrent,
            HTTP_STATUS.BAD_REQUEST
          );

        passwordProof = {
          accountId: credential.accountId,
          expectedHash: credential.expectedHash,
        };
      } else
        passwordProof = await verifyLoginAttempt({
          userId,
          password: input.currentPassword,
          skipTimingGuard: true,
          returnPasswordProof: true,
          auditMeta,
          purpose: 'reauth_change_password',
        });
    } catch (error) {
      throw asCurrentPasswordIncorrect(error);
    }

    const hashedPassword = await hashPassword(input.newPassword);

    await withTransaction(async (tx) => {
      // Liveness rechecked after hashing, so a concurrent suspension cannot
      // commit a credential change. The user lock comes first because rotation
      // writes the user after the credential.
      const [freshUser] = await tx
        .select({ roleId: users.roleId, isActive: users.isActive })
        .from(users)
        .where(liveUser(eq(users.id, userId)))
        .for('update');

      if (!freshUser || !freshUser.isActive || !freshUser.roleId)
        throw insufficientPermissions();

      const [account] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, passwordProof.accountId),
            eq(accounts.userId, userId),
            eq(accounts.providerId, CREDENTIAL_PROVIDER_ID),
            eq(accounts.password, passwordProof.expectedHash)
          )
        )
        .for('update');

      if (!account)
        throw new CustomError(
          userMsg.passwordUpdateFailed,
          HTTP_STATUS.BAD_REQUEST
        );

      await tx
        .update(accounts)
        .set({ password: hashedPassword })
        .where(eq(accounts.id, account.id));

      if (sessionId) await revokeOtherSessions(tx, userId, sessionId);

      // Every pending proof goes too: an unconsumed forgot-password or
      // passwordless proof would otherwise reset the NEW password. Trusted
      // devices are KEPT — this caller proved the old password on a live session,
      // so they are the owner; recovery, where they may not be, revokes them.
      await revokePendingProofs(tx, userId, null, 'keep');

      await auditLog(tx, {
        userId,
        userEmail: session.user.email,
        action: 'UPDATE',
        tableName: 'accounts',
        recordId: account.id,
        oldData: {},
        newData: { passwordChanged: true },
        meta: auditMeta,
      });
    });

    return { message: userMsg.passwordChanged, data: null };
  },
});

export const getPreferencesBinding = bind(getPreferences, {
  rateLimit: { scope: 'users.me.preferences.get', limit: 60, by: 'user' },
  failure: MSG_FETCH_ERROR,
  detail: {
    summary: 'Read the current dashboard appearance',
    description:
      'Answers the stored document, or the defaults with `updatedAt: null` when nothing has been saved — never 404, because the client needs a total document to reconcile its local copy against either way. `updatedAt` is the server-side write time, for a last-write-wins reconcile against a local copy.',
    tags: ['Account'],
  },
  handler: async ({ actor }) => {
    const [row] = await db
      .select({ ui: userPreferences.ui, updatedAt: userPreferences.updatedAt })
      .from(userPreferences)
      .where(eq(userPreferences.userId, actor.userId));

    // Defaults, not 404: the client reconciles against a total document.
    return {
      message: MSG_FETCHED,
      data: {
        preferences: sanitizePreferences(row?.ui),
        updatedAt: row?.updatedAt.toISOString() ?? null,
      },
    };
  },
});

/**
 * `PUT`, not `PATCH`: `HttpMethod` is a closed set the 405 boundary answers from.
 * No audit entry: `audit_logs` has no retention sweep, and a debounced slider
 * would fill it with rows nobody reads.
 */
export const updatePreferencesBinding = bind(updatePreferences, {
  rateLimit: {
    scope: 'users.me.preferences.put',
    limit: 30,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_UPDATE_ERROR,
  detail: {
    summary: 'Replace the dashboard appearance',
    description:
      'Replaces the whole document; a partial body is rejected. Answers the new `updatedAt`. Rate limited per user, so a client bound to a slider must debounce.',
    tags: ['Account'],
  },
  handler: async ({ body: input, actor }) => {
    const [row] = await db
      .insert(userPreferences)
      .values({ userId: actor.userId, ui: input })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ui: input },
      })
      .returning({ updatedAt: userPreferences.updatedAt });
    if (!row)
      throw new CustomError(MSG_UPDATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

    return {
      message: MSG_UPDATED,
      data: { updatedAt: row.updatedAt.toISOString() },
    };
  },
});
