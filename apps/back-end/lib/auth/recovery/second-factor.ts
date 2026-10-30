/**
 * The caller's budget is spent on guesses only: `rejected` compared and lost,
 * `unavailable` never reached a comparison and is refunded.
 */
import type { OfferedOption } from '../two-factor/methods';
import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';

import { and, eq, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { twoFactorCredentials } from '@/db/schema';

import { contactKindOf } from '@app/shared/validation/enums';

import { invalidOrExpiredCode } from '@/lib/otp/throttle';
import { processOtpVerify } from '@/lib/otp/verify';
import { contactOf } from '@/lib/users/contact';

import { auth } from '..';
import { accountTemporarilyLocked } from '../login-guard';
import {
  decodeBackupCodes,
  encodeBackupCodes,
} from '../two-factor/backup-codes';
import {
  consumeTotpCode,
  readVerifiedTotpSecret,
} from '../two-factor/totp-replay';
import { lockUser } from '../user-eligibility';
import { expiresIn } from '../verifications';

export type RecoveryVerdict = 'matched' | 'rejected' | 'unavailable';

/**
 * Better Auth's `accountLockout` defaults, which its sign-in verifiers apply to
 * the same `two_factor_credentials` row; `two-factor-library-drift.test.ts`
 * pins them. Recovery guesses count toward that one budget, or a holder of the
 * recovery mailbox could keep guessing while sign-in is locked.
 */
export const TWO_FACTOR_LOCKOUT_MAX_FAILURES = 10;
export const TWO_FACTOR_LOCKOUT_S = 900;

/**
 * ⚠️ One transaction under the user lock: the lock check, the comparison and
 * the counter change must not interleave, or concurrent guesses compare past
 * the threshold and a match clears a lock taken after its own check.
 */
async function underTwoFactorLockout(
  userId: EntityID,
  check: (tx: Tx) => Promise<RecoveryVerdict>
): Promise<RecoveryVerdict> {
  return withTransaction(async (tx) => {
    await lockUser(tx, userId);
    const [credential] = await tx
      .select({ lockedUntil: twoFactorCredentials.lockedUntil })
      .from(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, userId))
      .limit(1);
    if (credential?.lockedUntil && credential.lockedUntil > new Date())
      throw accountTemporarilyLocked(credential.lockedUntil);

    const verdict = await check(tx);
    if (verdict === 'rejected') {
      // ⚠️ Safe only because every writer of these columns holds the user lock
      // (sign-in through `withTwoFactorChallengeTransaction`); one that did not
      // could have a lock it just set cleared here. An expired lock restarts the
      // count, as the library clears it lazily.
      const failures = sql`case when ${twoFactorCredentials.lockedUntil} is null
        then ${twoFactorCredentials.failedVerificationCount} + 1 else 1 end`;
      await tx
        .update(twoFactorCredentials)
        .set({
          failedVerificationCount: failures,
          lockedUntil: sql`case when ${failures} >= ${TWO_FACTOR_LOCKOUT_MAX_FAILURES}
            then ${expiresIn(TWO_FACTOR_LOCKOUT_S)}::timestamptz end`,
        })
        .where(eq(twoFactorCredentials.userId, userId));
    } else if (verdict === 'matched')
      await tx
        .update(twoFactorCredentials)
        .set({ failedVerificationCount: 0, lockedUntil: null })
        .where(eq(twoFactorCredentials.userId, userId));
    return verdict;
  });
}

// From Better Auth's context, not the environment: a second derivation would
// stop matching once `BETTER_AUTH_SECRETS` is configured.
async function secretKey() {
  const context = await auth.$context;
  return context.secretConfig;
}

/** An OTP answers `'matched'` or throws; classify with `otpGuessWasEvaluated`. */
export async function verifyRecoveryFactor(
  option: OfferedOption,
  user: { id: EntityID; email: string; phoneNumber: string | null },
  code: string,
  auditMeta: AuditMeta
): Promise<RecoveryVerdict> {
  if (option.method === 'totp')
    return underTwoFactorLockout(user.id, (tx) =>
      verifyRecoveryTotp(tx, user.id, code)
    );
  if (option.method === 'backup_code')
    return underTwoFactorLockout(user.id, (tx) =>
      consumeRecoveryBackupCode(tx, user.id, code)
    );
  if (option.method === 'otp' && option.channel) {
    const destination = contactOf(user, contactKindOf(option.channel));
    if (!destination) throw invalidOrExpiredCode();
    await processOtpVerify({
      userId: user.id,
      userEmail: user.email,
      channel: option.channel,
      purpose: 'two_factor',
      identifier: destination,
      code,
      auditMeta,
    });
    return 'matched';
  }
  return 'unavailable';
}

async function verifyRecoveryTotp(
  tx: Tx,
  userId: EntityID,
  code: string
): Promise<RecoveryVerdict> {
  const secret = await readVerifiedTotpSecret(userId, await secretKey(), tx);
  if (!secret) return 'unavailable';
  // Spent, not just compared: the secret is shared with sign-in. A replay
  // must read as `'rejected'`.
  const verdict = await consumeTotpCode(userId, secret, code, { executor: tx });
  return verdict === 'matched' ? 'matched' : 'rejected';
}

// ⚠️ Guarded on the blob it read, as the plugin's verifier does, so two
// requests cannot both spend one code.
async function consumeRecoveryBackupCode(
  tx: Tx,
  userId: EntityID,
  code: string
): Promise<RecoveryVerdict> {
  const key = await secretKey();
  const [credential] = await tx
    .select({
      id: twoFactorCredentials.id,
      backupCodes: twoFactorCredentials.backupCodes,
      acknowledgedSetId: twoFactorCredentials.backupCodesAcknowledgedSetId,
      setId: twoFactorCredentials.backupCodesSetId,
    })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, userId))
    .limit(1);
  // Both ids are NULL before the first generation — see `backupCodesReady`.
  if (
    credential?.acknowledgedSetId == null ||
    credential.acknowledgedSetId !== credential.setId
  )
    return 'unavailable';

  const codes = await decodeBackupCodes(key, credential.backupCodes);
  if (!codes) return 'unavailable';
  if (!codes.includes(code)) return 'rejected';

  const remaining = codes.filter((entry) => entry !== code);
  const reEncrypted = await encodeBackupCodes(key, remaining);

  const [updated] = await tx
    .update(twoFactorCredentials)
    .set({
      backupCodes: reEncrypted,
      backupCodesRemaining: remaining.length,
    })
    .where(
      and(
        eq(twoFactorCredentials.id, credential.id),
        eq(twoFactorCredentials.backupCodes, credential.backupCodes)
      )
    )
    .returning({ id: twoFactorCredentials.id });
  // A lost swap is not a guess: the code matched what this request read.
  return updated ? 'matched' : 'unavailable';
}
