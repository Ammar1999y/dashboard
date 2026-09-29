import crypto from 'node:crypto';
import type { EntityID } from '@app/shared/types';
import type { SymmetricDecryptOptions } from 'better-auth/crypto';

import { eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { twoFactorCredentials } from '@/db/schema';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

/** Matches the plugin's own generator, so a stored set reads back identically. */
const BACKUP_CODE_ALPHABET =
  'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

export function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    let code = '';
    for (let i = 0; i < BACKUP_CODE_LENGTH; i++)
      code += BACKUP_CODE_ALPHABET.charAt(
        crypto.randomInt(BACKUP_CODE_ALPHABET.length)
      );
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/**
 * The exact storage the plugin's `verify-backup-code` reads back: a JSON array
 * under `symmetricEncrypt`, which is what `storeBackupCodes: "encrypted"` — the
 * default this deployment leaves in place — means.
 */
export function encodeBackupCodes(
  key: SymmetricDecryptOptions['key'],
  codes: string[]
): Promise<string> {
  return symmetricEncrypt({ key, data: JSON.stringify(codes) });
}

/** The set `encodeBackupCodes` stored, or `null` when the blob is not one. */
export async function decodeBackupCodes(
  key: SymmetricDecryptOptions['key'],
  blob: string
): Promise<string[] | null> {
  const decrypted = await symmetricDecrypt({ key, data: blob }).catch(
    () => null
  );
  if (!decrypted) return null;

  let codes: unknown;
  try {
    codes = JSON.parse(decrypted);
  } catch {
    return null;
  }
  if (
    !Array.isArray(codes) ||
    !codes.every((entry): entry is string => typeof entry === 'string')
  )
    return null;
  return codes;
}

/**
 * One backup code was just spent by the plugin's verifier.
 *
 * ⚠️ The count is kept in a column because the codes themselves live in one
 * encrypted blob that cannot be counted without the key, and `readEnrolmentState`
 * runs on every sign-in. The plugin owns the blob, so this is the one place the
 * two can disagree — and the direction is chosen: a LOST decrement leaves the
 * count too high, so the method stays offered and an exhausted set answers
 * "invalid code" rather than the user being silently refused a factor they
 * still hold. `GREATEST(..., 0)` is what keeps it from going negative when they
 * do drift.
 */
export async function spendBackupCode(userId: EntityID): Promise<void> {
  await db
    .update(twoFactorCredentials)
    .set({
      backupCodesRemaining: sql`GREATEST(${twoFactorCredentials.backupCodesRemaining} - 1, 0)`,
    })
    .where(eq(twoFactorCredentials.userId, userId));
}
