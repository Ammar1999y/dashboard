/**
 * The single policy for what a credential rotation invalidates (phone counts: it
 * is a passwordless factor). Callers hold the `users` lock; lock order is
 * users -> sessions / verification_sessions -> trusted_devices / verifications.
 * Every caller takes the user's row first, so these rows are only reached
 * behind it, and work added at the END cannot form a cycle among them.
 */
import type { Executor, Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';
import type { SQL } from 'drizzle-orm';

import { and, eq, like, ne, sql } from 'drizzle-orm';

import {
  accounts,
  sessions,
  trustedDevices,
  users,
  verifications,
  verificationSessions,
} from '@/db/schema';

import { auditLog } from '@/lib/audit';

import { GOOGLE_PROVIDER_ID } from '../credential';
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
 * A proof whose verification started at `startedAt` (`authenticationStartedAt`)
 * is void once a rotation stamped at or after it. Read under the user lock.
 */
export function rotatedSince(
  user: { authRevokedAt: Date | null },
  startedAt: number
): boolean {
  return (
    user.authRevokedAt !== null && user.authRevokedAt.getTime() >= startedAt
  );
}

// ⚠️ One array parameter, not `inArray`: a list binds one parameter per key,
// PostgreSQL refuses a statement past 65,535, and a user can hold enough
// sessions or challenges to reach it, which would fail every rotation of theirs.
async function deleteVerifications(
  executor: Executor,
  identifiers: readonly string[]
): Promise<void> {
  if (identifiers.length === 0) return;
  await executor
    .delete(verifications)
    .where(
      sql`${verifications.identifier} = any(${sql.param(identifiers)}::text[])`
    );
}

/**
 * ⚠️ These rows hold no user id, so every session delete owes this call —
 * Better Auth's via `session.delete.after` (`hooks.ts`), after its transaction
 * committed, hence `Executor`.
 */
export async function revokeSessionArtifacts(
  tx: Executor,
  sessionIds: readonly string[]
): Promise<void> {
  await deleteVerifications(
    tx,
    sessionIds.flatMap((id) => [
      twoFactorProofKey(id),
      reauthMethodKey(id),
      reauthPasskeyKey(id),
    ])
  );
}

export async function revokeSessionsWhere(
  tx: Executor,
  where: SQL | undefined
): Promise<string[]> {
  const removed = await tx
    .delete(sessions)
    .where(where)
    .returning({ id: sessions.id });
  const ids = removed.map((session) => session.id);
  await revokeSessionArtifacts(tx, ids);
  return ids;
}

/**
 * ⚠️ `value = userId` misses rows valued otherwise (challenge companions,
 * session-keyed proofs), so those are reached through challenge ids and
 * sessions. The passkey plugin's ceremony rows are left to the retention sweep.
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

  await deleteVerifications(
    tx,
    challenges.flatMap(({ identifier }) => [
      twoFactorAttemptsKey(identifier),
      twoFactorStateKey(identifier),
      twoFactorWebauthnKey(identifier),
    ])
  );

  await tx.delete(verifications).where(eq(verifications.value, userId));

  // ⚠️ Method removal keeps the caller's session; its surviving proof could
  // mint a new trusted device. Reaches surviving sessions only.
  const owned = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  await revokeSessionArtifacts(
    tx,
    owned.map((session) => session.id)
  );
}

// Trust granted against a factor that may be gone is a bypass. A voluntary
// password change skips this — see `revokePendingProofs`.
export async function revokeTwoFactorState(
  tx: Tx,
  userId: EntityID
): Promise<void> {
  await revokeTrustedDevices(tx, userId);
  await revokeVerificationArtifacts(tx, userId);
}

// Split out for bulk session revocation: trusted devices outlive every session,
// but enrolment and in-flight challenges must stay.
export async function revokeTrustedDevices(
  tx: Tx,
  userId: EntityID
): Promise<void> {
  await tx.delete(trustedDevices).where(eq(trustedDevices.userId, userId));
}

export async function revokeOtherSessions(
  tx: Tx,
  userId: EntityID,
  keepSessionId?: string | null
): Promise<void> {
  await revokeSessionsWhere(
    tx,
    keepSessionId
      ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
      : eq(sessions.userId, userId)
  );
}

/**
 * `'keep'` is only for a voluntary password change proven with the old password
 * on a live session. Every other rotation revokes: the actor may not be the
 * owner, or the trusted factor is gone.
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

/** `actor` is whoever caused it: the user on self-service, the admin otherwise. */
export async function unlinkGoogle(
  tx: Tx,
  userId: EntityID,
  actor: { userId: EntityID; email: string },
  auditMeta: AuditMeta
): Promise<void> {
  const removed = await tx
    .delete(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.providerId, GOOGLE_PROVIDER_ID)
      )
    )
    .returning({ id: accounts.id });
  for (const account of removed)
    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.email,
      action: 'DELETE',
      tableName: 'accounts',
      recordId: account.id,
      oldData: { provider: 'google', identityLinked: true, forUserId: userId },
      newData: {
        provider: 'google',
        identityLinked: false,
        reason: 'google_identity_unlinked',
        forUserId: userId,
      },
      metadataFields: ['forUserId'],
      meta: auditMeta,
    });
}
