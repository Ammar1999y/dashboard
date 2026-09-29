/**
 * Proving a second factor during password recovery, where there is neither a
 * session nor a sign-in challenge to hang it off.
 *
 * The set this can be asked for is decided by `recoveryOptions` in
 * `two-factor/methods.ts`; this module only checks what it is handed.
 *
 * Each check answers with a VERDICT rather than a boolean, because the caller
 * holds an attempt budget that is spent on guesses only: `rejected` is a code
 * that was compared and lost, `unavailable` is a check that never reached a
 * comparison — no credential, a decrypt failure, an unacknowledged set, a spend
 * lost to a concurrent request — and is refunded.
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

/**
 * The key the two-factor material is stored under.
 *
 * Read from Better Auth's own resolved context rather than from the environment:
 * `secretConfig` is what the plugin encrypts with, and a second derivation here
 * would silently stop matching the day a deployment configures `BETTER_AUTH_SECRETS`.
 */
async function secretKey() {
  const context = await auth.$context;
  return context.secretConfig;
}

/**
 * Proves `code` against `option`. An OTP answers `'matched'` or throws, and the
 * throw is the caller's to classify with `otpGuessWasEvaluated`.
 */
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

/** A TOTP code, with the one-period tolerance every other verifier here allows. */
async function verifyRecoveryTotp(
  userId: EntityID,
  code: string
): Promise<RecoveryVerdict> {
  const secret = await readVerifiedTotpSecret(userId, await secretKey());
  if (!secret) return 'unavailable';
  // Spent, not merely compared: recovery is one of three verifiers sharing this
  // secret, and a code accepted by any of them must not be accepted again by
  // this one. `'replayed'` reaches the caller as `'rejected'` — the recovery
  // path answers every failure with one message, and distinguishing them here
  // would tell a holder of a captured code that their capture was good.
  const verdict = await consumeTotpCode(userId, secret, code);
  return verdict === 'matched' ? 'matched' : 'rejected';
}

/**
 * Spends one backup code.
 *
 * ⚠️ The rewrite is guarded on the blob it READ. That is what makes consumption
 * single-use under concurrency — two requests holding the same code cannot both
 * spend it — and it is the protocol the plugin's own verifier uses on the same
 * column, so the two cannot disagree about what "spent" means.
 */
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
  // Both ids are NULL before the first generation, where equality alone would
  // read as "acknowledged" — see `backupCodesReady`.
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
    // A lost swap means another request rewrote the set first. The code matched
    // what this request read, so it is not a guess — and it may already be spent.
    return updated ? 'matched' : 'unavailable';
  });
}
