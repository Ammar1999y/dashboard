/**
 * The single policy for what a credential or identity rotation invalidates.
 * Password, email and phone are all credentials — phone is a passwordless login
 * factor — so every rotation routes through these helpers rather than choosing
 * its own subset.
 *
 * All run inside the caller's transaction after the `users` row is locked, in
 * the canonical lock order users -> sessions / verification_sessions ->
 * trusted_devices / verifications. Nothing else locks the last two, so adding
 * work at the END of that order cannot introduce a cycle.
 */
import type { Executor, Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';

import { and, eq, inArray, like, ne, sql } from 'drizzle-orm';

import {
  accounts,
  sessions,
  trustedDevices,
  users,
  verifications,
  verificationSessions,
} from '@/db/schema';

import { auditLog } from '@/lib/audit';

import {
  reauthMethodKey,
  reauthPasskeyKey,
  TWO_FACTOR_KEY_PATTERN,
  twoFactorAttemptsKey,
  twoFactorProofKey,
  twoFactorStateKey,
  twoFactorWebauthnKey,
} from '../verifications';

/**
 * The `verifications` rows keyed by SESSION id: the two-factor proof, the
 * re-authentication method and the passkey ceremony.
 *
 * None stores the user id, so a session deleted without them leaves rows
 * nothing can find again until they expire. Every path that deletes a session
 * owes this call: this codebase's own deletes inside their transaction, Better
 * Auth's through the `session.delete.after` hook in `lib/auth/index.ts` — which
 * runs after the library's transaction committed, hence `Executor`.
 */
export async function revokeSessionArtifacts(
  tx: Executor,
  sessionIds: readonly string[]
): Promise<void> {
  if (sessionIds.length === 0) return;
  await tx.delete(verifications).where(
    inArray(
      verifications.identifier,
      sessionIds.flatMap((id) => [
        twoFactorProofKey(id),
        reauthMethodKey(id),
        reauthPasskeyKey(id),
      ])
    )
  );
}

/**
 * Every `verifications` row this deployment writes on a user's behalf.
 *
 * ⚠️ `WHERE value = userId` finds only the rows valued by the user id, such as
 * the challenge and the re-authentication grants. The challenge's companions
 * store a count, a JSON document and a WebAuthn challenge, and the device-trust
 * proof a SESSION id, so each is reached through the challenge ids or the
 * user's sessions.
 *
 * The passkey plugin's own registration-ceremony rows are deliberately left to
 * the retention sweep: random identifier, nothing joining them to a user, and
 * useless without the challenge cookie.
 */
async function revokeVerificationArtifacts(
  tx: Tx,
  userId: EntityID
): Promise<void> {
  const challenges = await tx
    .delete(verifications)
    .where(
      and(
        eq(verifications.value, userId),
        like(verifications.identifier, TWO_FACTOR_KEY_PATTERN)
      )
    )
    .returning({ identifier: verifications.identifier });

  for (const challenge of challenges)
    await tx
      .delete(verifications)
      .where(
        inArray(verifications.identifier, [
          twoFactorAttemptsKey(challenge.identifier),
          twoFactorStateKey(challenge.identifier),
          twoFactorWebauthnKey(challenge.identifier),
        ])
      );

  // Every other row valued by the user id.
  await tx.delete(verifications).where(eq(verifications.value, userId));

  // ⚠️ The device-trust proof is keyed by SESSION id: method removal KEEPS the
  // caller's session, and a surviving proof would let it mint a new trusted
  // device right after the old ones were revoked. This reaches surviving
  // sessions only, which is why every session delete carries
  // `revokeSessionArtifacts` itself.
  const owned = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  await revokeSessionArtifacts(
    tx,
    owned.map((session) => session.id)
  );
}

/**
 * Drops every standing skip of the second factor, and any in-flight challenge.
 *
 * Recovery, method removal, an administrative reset and capability loss all take
 * this: each is a moment where a device trusted against a factor is a bypass of
 * a factor that may no longer exist. A VOLUNTARY password change does not — see
 * `revokePendingProofs`.
 */
export async function revokeTwoFactorState(
  tx: Tx,
  userId: EntityID
): Promise<void> {
  await revokeTrustedDevices(tx, userId);
  await revokeVerificationArtifacts(tx, userId);
}

/**
 * Every standing second-factor skip this user holds, and nothing else.
 *
 * Split out of `revokeTwoFactorState` for the containment case: bulk session
 * revocation must remove the trusted devices — they are keyed by their own
 * cookie and outlive every session, so signing out everywhere without them
 * leaves the attacker's device still skipping 2FA — but must NOT touch the
 * user's enrolment or an in-flight challenge, which that function also clears.
 */
export async function revokeTrustedDevices(
  tx: Tx,
  userId: EntityID
): Promise<void> {
  await tx.delete(trustedDevices).where(eq(trustedDevices.userId, userId));
}

/** Revoke every auth session for the user except the one making the request. */
export async function revokeOtherSessions(
  tx: Tx,
  userId: EntityID,
  keepSessionId?: string | null
): Promise<void> {
  const removed = await tx
    .delete(sessions)
    .where(
      keepSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
        : eq(sessions.userId, userId)
    )
    .returning({ id: sessions.id });
  await revokeSessionArtifacts(
    tx,
    removed.map((session) => session.id)
  );
}

/**
 * Removes proofs invalidated by credential rotation. The proof being consumed
 * may be retained long enough to record its final state.
 *
 * Trusted devices are a PARAMETER because the answer differs by event:
 *
 *  - `'revoke'` — recovery, contact change, administrative reset, user deletion.
 *    The person performing the change may not be the account's owner, or the
 *    factor the trust was granted against has just gone.
 *  - `'keep'` — a voluntary password change made by a caller who already proved
 *    the old password on a live session. Their trusted devices are theirs; the
 *    user should be TOLD about them, not silently signed out of them.
 */
export async function revokePendingProofs(
  tx: Tx,
  userId: EntityID,
  keepVerificationSessionId?: string | null,
  trustedDeviceRotation: 'revoke' | 'keep' = 'revoke'
): Promise<void> {
  await tx
    .update(users)
    .set({ authRevokedAt: sql`clock_timestamp()`, updatedAt: users.updatedAt })
    .where(eq(users.id, userId));
  await tx
    .delete(verificationSessions)
    .where(
      keepVerificationSessionId
        ? and(
            eq(verificationSessions.userId, userId),
            ne(verificationSessions.id, keepVerificationSessionId)
          )
        : eq(verificationSessions.userId, userId)
    );

  if (trustedDeviceRotation === 'revoke')
    await revokeTwoFactorState(tx, userId);
  else await revokeVerificationArtifacts(tx, userId);
}

export async function unlinkGoogle(
  tx: Tx,
  userId: EntityID,
  auditMeta: AuditMeta
): Promise<void> {
  const removed = await tx
    .delete(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'google')))
    .returning({ id: accounts.id });
  if (removed.length === 0) return;
  const [user] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw new Error('Unlinked identity has no local user.');
  for (const account of removed)
    await auditLog(tx, {
      userId,
      userEmail: user.email,
      action: 'DELETE',
      tableName: 'accounts',
      recordId: account.id,
      oldData: { provider: 'google', identityLinked: true },
      newData: {
        provider: 'google',
        identityLinked: false,
        reason: 'google_identity_unlinked',
      },
      meta: auditMeta,
    });
}
