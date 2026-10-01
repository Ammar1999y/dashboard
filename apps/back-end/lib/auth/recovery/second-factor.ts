/**
 * The caller's budget is spent on guesses only: `rejected` compared and lost,
 * `unavailable` never reached a comparison and is refunded.
 */
import type { OfferedOption } from '../two-factor/methods';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';

import { and, eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { twoFactorCredentials } from '@/db/schema';

import { contactKindOf } from '@app/shared/validation/enums';

import { invalidOrExpiredCode } from '@/lib/otp/throttle';
import { processOtpVerify } from '@/lib/otp/verify';
import { contactOf } from '@/lib/users/contact';

import { auth } from '..';
import {
  decodeBackupCodes,
  encodeBackupCodes,
} from '../two-factor/backup-codes';
import {
  consumeTotpCode,
  readVerifiedTotpSecret,
} from '../two-factor/totp-replay';

export type RecoveryVerdict = 'matched' | 'rejected' | 'unavailable';

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
  if (option.method === 'totp') return verifyRecoveryTotp(user.id, code);
  if (option.method === 'backup_code')
    return consumeRecoveryBackupCode(user.id, code);
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
  userId: EntityID,
  code: string
): Promise<RecoveryVerdict> {
  const secret = await readVerifiedTotpSecret(userId, await secretKey());
  if (!secret) return 'unavailable';
  // Spent, not just compared: the secret is shared with sign-in. A replay
  // must read as `'rejected'`.
  const verdict = await consumeTotpCode(userId, secret, code);
  return verdict === 'matched' ? 'matched' : 'rejected';
}

// ⚠️ Guarded on the blob it read, as the plugin's verifier does, so two
// requests cannot both spend one code.
async function consumeRecoveryBackupCode(
  userId: EntityID,
  code: string
): Promise<RecoveryVerdict> {
  const key = await secretKey();
  const [credential] = await db
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

  return withTransaction(async (tx) => {
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
  });
}
